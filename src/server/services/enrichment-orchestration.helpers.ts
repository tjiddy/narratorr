import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { normalizeProductionType } from '../../core/metadata/production-type.js';
import { RateLimitError } from '../../core/index.js';
import type { EnrichmentStatus } from '../../shared/schemas/enrichment.js';
import { serializeError } from '../utils/serialize-error.js';


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
  const processingSettings = await deps.settingsService.get('processing');
  const ffprobePath = resolveFfprobePathFromSettings(processingSettings?.ffmpegPath);
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

  // ASIN recovery loop — precise identity fast path; first hit wins.
  for (const asin of asinsToTry) {
    try {
      const data = await deps.metadataService.enrichBook(asin);
      if (data) {
        await applyEnrichmentData(bookId, asin, data, opts, deps);
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
    await applyEnrichmentData(bookId, resolved.asin, resolved, opts, deps);
  }
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
  if (!resolvedAsin || resolvedAsin === primaryAsin) return undefined;
  const collision = await deps.bookService.findAsinCollision(bookId, resolvedAsin);
  if (collision) {
    deps.log.warn(
      { bookId, resolvedAsin, conflictBookId: collision.conflictBookId },
      'Resolved ASIN collides with an existing book — keeping fetched fields, skipping ASIN writeback',
    );
    return undefined;
  }
  return resolvedAsin;
}

async function applyEnrichmentData(
  bookId: number,
  resolvedAsin: string | null | undefined,
  data: { duration?: number | undefined; narrators?: string[] | undefined; genres?: string[] | undefined; subtitle?: string | undefined; publisher?: string | undefined },
  opts: { primaryAsin?: string | null | undefined; existingNarrator?: string | null | undefined; existingDuration?: number | null | undefined; existingGenres?: string[] | null | undefined; existingSubtitle?: string | null | undefined; existingPublisher?: string | null | undefined },
  deps: Pick<EnrichmentDeps, 'db' | 'log' | 'bookService'>,
): Promise<void> {
  const updates: Partial<{ enrichmentStatus: EnrichmentStatus; asin: string; duration: number; subtitle: string; publisher: string; updatedAt: Date }> = {
    enrichmentStatus: 'enriched',
    updatedAt: new Date(),
  };
  const asinToWrite = await resolveAsinWriteback(bookId, resolvedAsin, opts.primaryAsin, deps);
  if (asinToWrite) updates.asin = asinToWrite;
  if (!opts.existingDuration && data.duration) {
    updates.duration = data.duration;
  }
  if (!opts.existingSubtitle && data.subtitle) {
    updates.subtitle = data.subtitle;
  }
  if (!opts.existingPublisher && data.publisher) {
    updates.publisher = data.publisher;
  }
  await deps.db.update(books).set(updates).where(eq(books.id, bookId));
  await applyEnrichmentArrayFields(bookId, data, opts, deps);
  deps.log.info(
    { bookId, asin: resolvedAsin ?? null, wasAlternate: !!resolvedAsin && resolvedAsin !== opts.primaryAsin },
    'Audnexus enrichment applied',
  );
}

/** Fill-guarded narrator/genre writes (separate rows, so they bypass the scalar `updates` set). */
async function applyEnrichmentArrayFields(
  bookId: number,
  data: { narrators?: string[] | undefined; genres?: string[] | undefined },
  opts: { existingNarrator?: string | null | undefined; existingGenres?: string[] | null | undefined },
  deps: Pick<EnrichmentDeps, 'bookService'>,
): Promise<void> {
  if (!opts.existingNarrator && data.narrators?.length) {
    await deps.bookService.update(bookId, { narrators: data.narrators });
  }
  if (data.genres?.length && !opts.existingGenres?.length) {
    await deps.bookService.update(bookId, { genres: data.genres });
  }
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
  return {
    title: item.title,
    // When metadata provides multiple authors (co-authored books), preserve the full array.
    // For single-author metadata, defer to the parsed folder author (allows user override).
    authors: (meta?.authors && meta.authors.length > 1)
      ? meta.authors
      : (item.authorName ? [{ name: item.authorName }] : (meta?.authors?.length ? meta.authors : [])),
    narrators: item.narrators?.length ? item.narrators : meta?.narrators,
    // Provider-truth precedence: accepted provider metadata wins over raw item/tag fields.
    // Prefer the canonical primary-series ref over `series[0]` (#1088 / #1097) —
    // `series[0]` on Audible can be a broader universe entry rather than the
    // real book series. When `meta` is null (no provider match accepted), fall back to item-derived values.
    seriesName: (meta?.seriesPrimary ?? meta?.series?.[0])?.name ?? item.seriesName ?? undefined,
    seriesPosition: (meta?.seriesPrimary ?? meta?.series?.[0])?.position ?? (item.seriesPosition !== undefined ? item.seriesPosition : undefined),
    seriesAsin: (meta?.seriesPrimary ?? meta?.series?.[0])?.asin ?? undefined,
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
