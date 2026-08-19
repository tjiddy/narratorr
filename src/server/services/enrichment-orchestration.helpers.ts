import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import type { NarratorSource } from './import-adapters/types.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import { enrichBookFromAudioWithinAdmissionLock, rowHasNarrators, type AudioEnrichmentOptions } from './enrichment-utils.js';
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

export interface EnrichmentBookInput {
  narrators: Array<{ name: string }> | null;
  duration: number | null;
  coverUrl: string | null;
  existingGenres: string[] | null;
  /** Absent keeps existing narrator semantics. */
  narratorSource?: NarratorSource | undefined;
}

export interface AudnexusConfig {
  primaryAsin?: string | null | undefined;
  alternateAsins?: string[] | undefined;
  title?: string | null | undefined;
  author?: string | null | undefined;
  existingNarrator?: string | null | undefined;
}

export interface EnrichmentDeps {
  db: Db;
  log: FastifyBaseLogger;
  settingsService: SettingsService;
  bookService: BookService;
  metadataService: MetadataService;
}

/**
 * Caller must hold the admission lock for `bookId`.
 *
 * Runs audio before provider enrichment; callers own statuses, events, and errors. Both halves
 * write the same row and the same folder, so they belong to one section — a split would let a Fix
 * Match land between the audio writeback and the provider writeback.
 */
export async function orchestrateBookEnrichment(
  bookId: number,
  finalPath: string,
  book: EnrichmentBookInput,
  deps: EnrichmentDeps,
  audnexusConfig: AudnexusConfig,
  opts?: AudioEnrichmentOptions,
): Promise<{ audioEnriched: boolean }> {
  const ffprobePath = resolveFfprobePathFromSettings(await resolveFfmpegPath());
  const audioResult = await enrichBookFromAudioWithinAdmissionLock(
    bookId,
    finalPath,
    {
      narrators: book.narrators ?? null,
      duration: book.duration ?? null,
      coverUrl: book.coverUrl ?? null,
      // Preserve the legacy argument shape when provenance is absent.
      ...(book.narratorSource !== undefined && { narratorSource: book.narratorSource }),
    },
    deps.db,
    deps.log,
    deps.bookService,
    ffprobePath,
    opts,
  );

  await applyAudnexusEnrichment(bookId, audnexusConfig, deps);

  return { audioEnriched: audioResult.enriched };
}

/** Caller must hold the admission lock for `bookId`. */
export async function applyAudnexusEnrichment(
  bookId: number,
  opts: AudnexusConfig,
  deps: Pick<EnrichmentDeps, 'db' | 'log' | 'bookService' | 'metadataService'>,
): Promise<void> {
  const asinsToTry = [opts.primaryAsin, ...(opts.alternateAsins ?? [])].filter((a): a is string => !!a);
  const title = opts.title?.trim();
  if (asinsToTry.length === 0 && !title) return;

  // Capture identity before provider I/O; the write transaction drops results if Fix Match repointed the row.
  const capturedAsin = await readBookAsin(deps.db, bookId);

  for (const asin of asinsToTry) {
    let data;
    try {
      data = await deps.metadataService.enrichBook(asin);
    } catch (error: unknown) {
      // Rate limits remain retryable; ordinary provider failures fall through to another identity.
      if (error instanceof RateLimitError) throw error;
      deps.log.warn({ error: serializeError(error), bookId, asin }, 'Audnexus enrichment failed');
      continue;
    }
    // Keep durable writes outside the provider catch; retrying after an ambiguous write failure can corrupt identity.
    if (data) {
      await applyEnrichmentData(bookId, asin, data, opts, deps, capturedAsin);
      return;
    }
  }

  if (!title) return;
  let resolved;
  try {
    resolved = await deps.metadataService.resolveBook({ title, author: opts.author?.trim() || undefined });
  } catch (error: unknown) {
    // Rate limits propagate; other search failures stay non-fatal so the scheduled job can retry.
    if (error instanceof RateLimitError) throw error;
    deps.log.warn({ error: serializeError(error), bookId, title }, 'Audnexus search fallback failed (transient) — leaving book pending');
    return;
  }
  if (resolved) {
    await applyEnrichmentData(bookId, resolved.asin, resolved, opts, deps, capturedAsin);
  }
}

async function readBookAsin(db: Db, bookId: number): Promise<string | null> {
  const rows = await db.select({ asin: books.asin }).from(books).where(eq(books.id, bookId)).limit(1);
  return canonicalizeAsin(rows[0]?.asin);
}

/** Write a canonical, collision-free ASIN only when it differs; fetched fields still apply on collision. */
async function resolveAsinWriteback(
  bookId: number,
  resolvedAsin: string | null | undefined,
  primaryAsin: string | null | undefined,
  deps: Pick<EnrichmentDeps, 'log' | 'bookService'>,
): Promise<string | undefined> {
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
 * Commit status and fill-empty writes atomically. Re-read identity and tombstones inside the
 * transaction so user edits made during provider I/O win; resolve ASIN collisions before opening it.
 */
async function applyEnrichmentData(
  bookId: number,
  resolvedAsin: string | null | undefined,
  data: { duration?: number | undefined; narrators?: string[] | undefined; genres?: string[] | undefined; subtitle?: string | undefined; publisher?: string | undefined },
  opts: { primaryAsin?: string | null | undefined; existingNarrator?: string | null | undefined },
  deps: Pick<EnrichmentDeps, 'db' | 'log' | 'bookService'>,
  capturedAsin: string | null,
): Promise<void> {
  const asinToWrite = await resolveAsinWriteback(bookId, resolvedAsin, opts.primaryAsin, deps);

  const committed = await deps.db.transaction(async (tx) => {
    // #2435 AC28: the projection covers every field this transaction writes, so each guard reads
    // the LIVE row — the sole gate. A caller's pre-fetch snapshot cannot be one: it predates the
    // audio scan and the provider round-trip, and an operator can populate any column meanwhile.
    const rows = await tx
      .select({
        asin: books.asin,
        userClearedFields: books.userClearedFields,
        duration: books.duration,
        subtitle: books.subtitle,
        publisher: books.publisher,
        genres: books.genres,
      })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    const row = rows[0];
    // Drop provider data when the row disappeared or changed identity during the fetch.
    if (!row || canonicalizeAsin(row.asin) !== capturedAsin) return { applied: false, genresWritten: null };

    const cleared = new Set(parseClearedFields(row.userClearedFields, deps.log, bookId));

    const updates: Partial<{ enrichmentStatus: EnrichmentStatus; asin: string; duration: number; subtitle: string; publisher: string; updatedAt: Date }> = {
      enrichmentStatus: 'enriched',
      updatedAt: new Date(),
    };
    if (asinToWrite) updates.asin = asinToWrite;
    // #2440: `books.duration` alone decides this. The removed caller snapshot came from the staged
    // item's provider metadata, so it could be set on a row whose own column was empty and refuse
    // the Audnexus duration; that case now fills.
    if (!row.duration && data.duration) {
      updates.duration = data.duration;
    }
    if (!row.subtitle && data.subtitle && !cleared.has('subtitle')) {
      updates.subtitle = data.subtitle;
    }
    if (!row.publisher && data.publisher && !cleared.has('publisher')) {
      updates.publisher = data.publisher;
    }
    await tx.update(books).set(updates).where(eq(books.id, bookId));
    const genresWritten = await applyEnrichmentArrayFields(bookId, data, opts, deps, cleared, tx, row.genres);
    return { applied: true, genresWritten };
  });

  if (!committed.applied) {
    deps.log.debug({ bookId, asin: capturedAsin }, 'stale post-import enrichment dropped (identity re-read)');
    return;
  }

  // Emit genre telemetry only after commit; a rollback must not strand side effects.
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

async function applyEnrichmentArrayFields(
  bookId: number,
  data: { narrators?: string[] | undefined; genres?: string[] | undefined },
  opts: { existingNarrator?: string | null | undefined },
  deps: Pick<EnrichmentDeps, 'bookService'>,
  cleared: ReadonlySet<ClearableBookField>,
  tx: DbOrTx,
  liveGenres: string[] | null,
): Promise<string[] | null> {
  if (!opts.existingNarrator && data.narrators?.length && !(await rowHasNarrators(tx, bookId))) {
    await deps.bookService.update(bookId, { narrators: data.narrators }, { tx });
  }
  if (data.genres?.length && !liveGenres?.length && !cleared.has('genres')) {
    await deps.bookService.update(bookId, { genres: data.genres }, { tx });
    return data.genres;
  }
  return null;
}

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

export function buildEnrichmentBookInput(
  book: {
    narrators?: Array<{ name: string }> | null;
    duration?: number | null;
    coverUrl?: string | null;
    genres?: string[] | null;
    narratorSource?: NarratorSource | undefined;
  },
): EnrichmentBookInput {
  return {
    narrators: book.narrators ?? null,
    duration: book.duration ?? null,
    coverUrl: book.coverUrl ?? null,
    existingGenres: book.genres ?? null,
    ...(book.narratorSource !== undefined && { narratorSource: book.narratorSource }),
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
): AudnexusConfig {
  return {
    primaryAsin: item.asin || extracted.meta?.asin,
    alternateAsins: extracted.meta?.alternateAsins,
    title: item.title ?? null,
    author: item.authorName ?? null,
    existingNarrator: extracted.narratorName,
  };
}

// eslint-disable-next-line complexity -- flat metadata coalescing across item + meta sources
export function buildBookCreatePayload(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  status: 'imported' | 'importing',
) {
  // Explicit import series wins as a name/position pair; otherwise use the provider's primary series.
  const series = resolveImportSeries(item, pickPrimarySeries(meta));
  return {
    title: item.title,
    // Preserve provider co-authors; for one author, the parsed import value may override.
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
    productionType: normalizeProductionType(meta?.formatType),
    status,
  };
}
