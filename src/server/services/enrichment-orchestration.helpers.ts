import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import type { BookMetadata } from '@core/metadata/index.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { RateLimitError } from '@core/index.js';
import type { EnrichmentStatus } from '@shared/schemas/enrichment.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import { resolveImportSeries } from './resolve-import-series.js';
import { serializeError } from '../utils/serialize-error.js';
import { parseClearedFields } from '../utils/cleared-fields.js';
import type { ClearableBookField } from '@shared/schemas/book.js';


// ─── Shared types ───────────────────────────────────────────────────────

export interface EnrichmentBookInput {
  narrators: Array<{ name: string }> | null;
  duration: number | null;
  coverUrl: string | null;
  existingGenres: string[] | null;
}

export interface AudnexusConfig {
  primaryAsin?: string | null | undefined;
  alternateAsins?: string[] | undefined;
  /** Search-fallback query inputs (post-import path): title + author from the import payload. */
  title?: string | null | undefined;
  author?: string | null | undefined;
  existingNarrator?: string | null | undefined;
  existingDuration?: number | null | undefined;
  existingGenres?: string[] | null | undefined;
  existingSubtitle?: string | null | undefined;
  existingPublisher?: string | null | undefined;
}

export interface EnrichmentDeps {
  db: Db;
  log: FastifyBaseLogger;
  settingsService: SettingsService;
  bookService: BookService;
  metadataService: MetadataService;
}

// ─── Enrichment orchestration ───────────────────────────────────────────

/**
 * Shared enrichment orchestration: audio metadata → audnexus.
 *
 * Callers own: status transitions, event recording (success/failure), error propagation.
 * This helper owns only the enrichment sequence and propagates all errors to the caller.
 */
export async function orchestrateBookEnrichment(
  bookId: number,
  finalPath: string,
  book: EnrichmentBookInput,
  deps: EnrichmentDeps,
  audnexusConfig: AudnexusConfig,
): Promise<{ audioEnriched: boolean }> {
  // Audio file metadata enrichment
  const ffprobePath = resolveFfprobePathFromSettings(await resolveFfmpegPath());
  const audioResult = await enrichBookFromAudio(
    bookId,
    finalPath,
    { narrators: book.narrators ?? null, duration: book.duration ?? null, coverUrl: book.coverUrl ?? null },
    deps.db,
    deps.log,
    deps.bookService,
    ffprobePath,
  );

  // Audnexus enrichment
  await applyAudnexusEnrichment(bookId, audnexusConfig, deps);

  return { audioEnriched: audioResult.enriched };
}

// ─── Audnexus enrichment ────────────────────────────────────────────────

export async function applyAudnexusEnrichment(
  bookId: number,
  opts: AudnexusConfig,
  deps: Pick<EnrichmentDeps, 'db' | 'log' | 'bookService' | 'metadataService'>,
): Promise<void> {
  const asinsToTry = [opts.primaryAsin, ...(opts.alternateAsins ?? [])].filter((a): a is string => !!a);
  const title = opts.title?.trim();
  // Nothing to resolve from: no ASIN to look up AND no title to search.
  if (asinsToTry.length === 0 && !title) return;

  // The row's ASIN as of BEFORE the provider fetch (#2069 AC11). `resolveAsinWriteback`
  // is not an identity guard: it canonicalizes the FETCHED asin, compares it to the
  // caller-supplied `primaryAsin`, and checks cross-row collision — it never reads the
  // row's current ASIN, so a Fix Match committed during the fetch is invisible to it.
  // The write transaction re-reads and compares against this captured value instead.
  const capturedAsin = await readBookAsin(deps.db, bookId);

  // ASIN recovery loop — precise identity fast path; first hit wins.
  for (const asin of asinsToTry) {
    try {
      const data = await deps.metadataService.enrichBook(asin);
      if (data) {
        await applyEnrichmentData(bookId, asin, data, opts, deps, capturedAsin);
        return;
      }
    } catch (error: unknown) {
      // A rate limit is a transient provider state, not a miss — propagate so the
      // caller leaves the book pending/retryable (matches the import-list + job paths).
      if (error instanceof RateLimitError) throw error;
      deps.log.warn({ error: serializeError(error), bookId, asin }, 'Audnexus enrichment failed');
    }
  }

  // Search fallback — every ASIN missed (or there were none). When every embedded
  // ASIN is a print/Kindle ASIN (or 404s), a title+author search re-finds the real
  // audiobook. Skipped with no title (never called with an empty query).
  if (!title) return;
  let resolved;
  try {
    resolved = await deps.metadataService.resolveBook({ title, author: opts.author?.trim() || undefined });
  } catch (error: unknown) {
    // A RateLimitError propagates by design (the manual adapter treats it as a
    // retryable import). Any OTHER thrown error is a transient provider failure
    // during a SUPPLEMENTARY post-import fetch — treat it as a non-fatal miss so
    // the import still completes and the book stays pending for the scheduled job
    // to retry. Mirrors the ASIN-recovery loop's catch above.
    if (error instanceof RateLimitError) throw error;
    deps.log.warn({ error: serializeError(error), bookId, title }, 'Audnexus search fallback failed (transient) — leaving book pending');
    return;
  }
  if (resolved) {
    await applyEnrichmentData(bookId, resolved.asin, resolved, opts, deps, capturedAsin);
  }
}

/** The row's current ASIN, canonicalized — the identity value AC11's write transaction re-checks. */
async function readBookAsin(db: Db, bookId: number): Promise<string | null> {
  const rows = await db.select({ asin: books.asin }).from(books).where(eq(books.id, bookId)).limit(1);
  return canonicalizeAsin(rows[0]?.asin);
}

/**
 * Decide the ASIN to write back. The resolved ASIN (a concrete loop ASIN, or the
 * search candidate's optional `asin`) is written only when it is a real string
 * differing from `primaryAsin` AND collision-free — `books.asin` is uniquely
 * indexed (`idx_books_asin_unique`). On collision we keep the just-fetched fields
 * but skip the ASIN write (the deliberate divergence from the background job,
 * which marks the row failed). Returns `undefined` when nothing should be written.
 */
async function resolveAsinWriteback(
  bookId: number,
  resolvedAsin: string | null | undefined,
  primaryAsin: string | null | undefined,
  deps: Pick<EnrichmentDeps, 'log' | 'bookService'>,
): Promise<string | undefined> {
  // Canonicalize the resolved ASIN at this write boundary (#1733) and compare
  // case-insensitively against the primary so a case-only "change" isn't written
  // back. The returned value is the canonical form actually persisted.
  const canonical = canonicalizeAsin(resolvedAsin);
  if (!canonical || canonical === canonicalizeAsin(primaryAsin)) return undefined;
  const collision = await deps.bookService.findAsinCollision(bookId, canonical);
  if (collision) {
    deps.log.warn(
      { bookId, resolvedAsin: canonical, conflictBookId: collision.conflictBookId },
      'Resolved ASIN collides with an existing book — keeping fetched fields, skipping ASIN writeback',
    );
    return undefined;
  }
  return canonical;
}

/**
 * Persist one Audnexus result. This is the SECOND fill-empty writer, so it honors
 * the same tombstones as the scheduled job, independently per field (#2069 AC10):
 * `subtitle` and `publisher` are dropped from the scalar payload when tombstoned,
 * and the genres fill is skipped when `genres` is. It writes NO series field, so
 * `seriesName`/`publishedDate` need no guard here — that asymmetry with AC9 is
 * deliberate, not an omission.
 *
 * Both writes now live in ONE transaction (AC11). They used to commit separately,
 * so `enrichmentStatus: 'enriched'` could land while a later write did not — and
 * the row is then permanently outside the scheduled candidate selector, which only
 * picks `pending`/`skipped`/retryable `failed`. Completion status and the field
 * writes now commit or roll back together.
 *
 * The tombstone set that drives the three suppressions is read INSIDE that
 * transaction, not from the caller's pre-fetch `db.select({ genres, subtitle,
 * publisher })`: that earlier read still supplies the `existing*` fill-empty
 * inputs, but it happens before a provider fetch a clear can commit during.
 *
 * `resolveAsinWriteback` stays OUTSIDE the transaction — it issues a collision
 * query on `this.db`, which must not run on (or alongside) the open handle.
 */
async function applyEnrichmentData(
  bookId: number,
  resolvedAsin: string | null | undefined,
  data: { duration?: number | undefined; narrators?: string[] | undefined; genres?: string[] | undefined; subtitle?: string | undefined; publisher?: string | undefined },
  opts: { primaryAsin?: string | null | undefined; existingNarrator?: string | null | undefined; existingDuration?: number | null | undefined; existingGenres?: string[] | null | undefined; existingSubtitle?: string | null | undefined; existingPublisher?: string | null | undefined },
  deps: Pick<EnrichmentDeps, 'db' | 'log' | 'bookService'>,
  capturedAsin: string | null,
): Promise<void> {
  const asinToWrite = await resolveAsinWriteback(bookId, resolvedAsin, opts.primaryAsin, deps);

  const committed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ asin: books.asin, userClearedFields: books.userClearedFields })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    const row = rows[0];
    // Identity guard: a Fix Match committed during the provider fetch re-pointed
    // this row, so the payload no longer describes it. A missing row is the same
    // outcome — there is nothing to enrich.
    if (!row || canonicalizeAsin(row.asin) !== capturedAsin) return { applied: false, genresWritten: null };

    const cleared = new Set(parseClearedFields(row.userClearedFields, deps.log, bookId));

    const updates: Partial<{ enrichmentStatus: EnrichmentStatus; asin: string; duration: number; subtitle: string; publisher: string; updatedAt: Date }> = {
      enrichmentStatus: 'enriched',
      updatedAt: new Date(),
    };
    if (asinToWrite) updates.asin = asinToWrite;
    if (!opts.existingDuration && data.duration) {
      updates.duration = data.duration;
    }
    if (!opts.existingSubtitle && data.subtitle && !cleared.has('subtitle')) {
      updates.subtitle = data.subtitle;
    }
    if (!opts.existingPublisher && data.publisher && !cleared.has('publisher')) {
      updates.publisher = data.publisher;
    }
    await tx.update(books).set(updates).where(eq(books.id, bookId));
    const genresWritten = await applyEnrichmentArrayFields(bookId, data, opts, deps, cleared, tx);
    return { applied: true, genresWritten };
  });

  // A stale drop is not a success — do not log one.
  if (!committed.applied) {
    deps.log.debug({ bookId, asin: capturedAsin }, 'stale post-import enrichment dropped (identity re-read)');
    return;
  }

  // Deferred effect, run only now that the write transaction has COMMITTED (#2069
  // F21/F5). `bookService.update`'s caller-owned-tx arm deliberately emits no
  // post-commit side effects — a rollback the owner may still perform would strand
  // them — so this owner runs the telemetry itself, after its own commit. Awaited
  // rather than fire-and-forget so the import cannot outlive its own telemetry;
  // still non-fatal, matching the `update()` wrapper.
  if (committed.genresWritten) {
    await deps.bookService.trackUnmatchedGenres(committed.genresWritten).catch((error: unknown) => {
      deps.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres');
    });
  }

  deps.log.info(
    { bookId, asin: resolvedAsin ?? null, wasAlternate: !!resolvedAsin && resolvedAsin !== opts.primaryAsin },
    'Audnexus enrichment applied',
  );
}

/**
 * Fill-guarded narrator/genre writes (separate rows, so they bypass the scalar
 * `updates` set). Runs on the caller's transaction handle — `bookService.update`
 * must not open a second one, since nesting `db.transaction` throws
 * `NestedTransactionError`. `narrators` is not clearable, so only the genres fill
 * consults the tombstone set.
 *
 * Returns the genre payload that actually landed, or `null` — the caller runs the
 * unmatched-genre telemetry for it AFTER the owning transaction commits (#2069
 * F21/F5). Narrators carry no telemetry, so only the genre arm reports back.
 */
async function applyEnrichmentArrayFields(
  bookId: number,
  data: { narrators?: string[] | undefined; genres?: string[] | undefined },
  opts: { existingNarrator?: string | null | undefined; existingGenres?: string[] | null | undefined },
  deps: Pick<EnrichmentDeps, 'bookService'>,
  cleared: ReadonlySet<ClearableBookField>,
  tx: DbOrTx,
): Promise<string[] | null> {
  if (!opts.existingNarrator && data.narrators?.length) {
    await deps.bookService.update(bookId, { narrators: data.narrators }, { tx });
  }
  if (data.genres?.length && !opts.existingGenres?.length && !cleared.has('genres')) {
    await deps.bookService.update(bookId, { genres: data.genres }, { tx });
    return data.genres;
  }
  return null;
}

// ─── Book creation payload ──────────────────────────────────────────────

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string | null;
  seriesName?: string | null;
  narrators?: string[];
  seriesPosition?: number;
  asin?: string | null;
  coverUrl?: string | null;
  metadata?: BookMetadata | null;
}

// ─── Enrichment input builders ──────────────────────────────────────────
// Extracted to reduce cyclomatic complexity in callers (each ?? and || counts as a branch).

export function buildEnrichmentBookInput(
  book: { narrators?: Array<{ name: string }> | null; duration?: number | null; coverUrl?: string | null; genres?: string[] | null },
): EnrichmentBookInput {
  return {
    narrators: book.narrators ?? null,
    duration: book.duration ?? null,
    coverUrl: book.coverUrl ?? null,
    existingGenres: book.genres ?? null,
  };
}

export function buildImportedEventPayload(
  bookId: number,
  item: { title: string; authorName?: string | null | undefined },
  narratorName: string | null,
  finalPath: string,
  mode?: string | null | undefined,
) {
  return {
    bookId,
    bookTitle: item.title,
    authorName: item.authorName ?? null,
    narratorName,
    downloadId: null,
    eventType: 'imported' as const,
    source: 'manual' as const,
    reason: { targetPath: finalPath, mode: mode ?? 'pointer' },
  };
}

/**
 * Extract metadata fields from an import item for the background import flow.
 * Centralizes the nullable coalescing that inflates cyclomatic complexity.
 */
function resolveEnrichmentNarrators(
  itemNarrators: string[] | undefined,
  metaNarrators: string[] | undefined,
): Array<{ name: string }> | null {
  if (itemNarrators?.length) return itemNarrators.map(name => ({ name }));
  if (metaNarrators?.length) return metaNarrators.map(name => ({ name }));
  return null;
}

export function extractImportMetadata(item: ImportConfirmItem) {
  const meta = item.metadata ?? null;
  const narratorName = item.narrators?.[0] ?? meta?.narrators?.[0] ?? null;
  const duration = meta?.duration ?? null;
  const coverUrl = item.coverUrl || meta?.coverUrl || null;
  const enrichmentNarrators = resolveEnrichmentNarrators(item.narrators, meta?.narrators);
  return {
    meta,
    narratorName,
    bookInput: {
      narrators: enrichmentNarrators,
      duration,
      coverUrl,
    },
  };
}

export function buildBackgroundAudnexusConfig(
  item: { asin?: string | null | undefined; title?: string | null | undefined; authorName?: string | null | undefined },
  extracted: ReturnType<typeof extractImportMetadata>,
  existingGenres: string[] | null,
  existing?: { subtitle?: string | null | undefined; publisher?: string | null | undefined } | undefined,
): AudnexusConfig {
  return {
    primaryAsin: item.asin || extracted.meta?.asin,
    alternateAsins: extracted.meta?.alternateAsins,
    // Search-fallback query: title/author come from the import payload (NOT the
    // currentBook re-read, which does not select them).
    title: item.title ?? null,
    author: item.authorName ?? null,
    existingNarrator: extracted.narratorName,
    existingDuration: extracted.bookInput.duration,
    existingGenres,
    existingSubtitle: existing?.subtitle ?? null,
    existingPublisher: existing?.publisher ?? null,
  };
}

// ─── Book creation payload ──────────────────────────────────────────────

// eslint-disable-next-line complexity -- flat metadata coalescing across item + meta sources
export function buildBookCreatePayload(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  status: 'imported' | 'importing',
) {
  // Item-first, two-state, pair-locked series resolution (#1927) — shared with
  // `copyToLibrary`'s `targetBook` so the DB record and the physical folder agree.
  // A user's explicit series edit wins over the matched metadata's primary series;
  // an absent (empty/whitespace) item series defers to metadata. `pickPrimarySeries`
  // (`seriesPrimary` over `series[0]`, #1088/#1097) still selects the defer-path ref.
  const series = resolveImportSeries(item, pickPrimarySeries(meta));
  return {
    title: item.title,
    // When metadata provides multiple authors (co-authored books), preserve the full array.
    // For single-author metadata, defer to the parsed folder author (allows user override).
    authors: (meta?.authors && meta.authors.length > 1)
      ? meta.authors
      : (item.authorName ? [{ name: item.authorName }] : (meta?.authors?.length ? meta.authors : [])),
    narrators: item.narrators?.length ? item.narrators : meta?.narrators,
    seriesName: series.name,
    seriesPosition: series.position,
    coverUrl: item.coverUrl || meta?.coverUrl,
    asin: item.asin || meta?.asin,
    isbn: meta?.isbn,
    subtitle: meta?.subtitle,
    description: meta?.description,
    publisher: meta?.publisher,
    duration: meta?.duration,
    publishedDate: meta?.publishedDate,
    genres: meta?.genres,
    providerId: meta?.providerId,
    // Recording production form (#1710). Only this manual-import/enrichment path
    // populates it in story 1; every other create path takes the column default.
    productionType: normalizeProductionType(meta?.formatType),
    status,
  };
}
