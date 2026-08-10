import type { FastifyBaseLogger } from 'fastify';
import { RateLimitError, TransientError } from '@core/index.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import type { ProductionType } from '@shared/schemas/book.js';
import type { EventSource } from '@shared/schemas/event-history.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { BookDetail, BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';

/**
 * Whether the resolved match or the caller owns the row's identity. `adopt` is the import-list rule:
 * a shelf item's title/author are user data and the provider's are canonical. `pin` is the Series
 * card's: the card's library pool is keyed on `books.seriesName`, so a row created under the
 * provider's series name is not on the card the operator was looking at, and its member stays
 * `+ Add` forever. Enrichment fills-if-empty, so a pinned row still gets the canonical title later.
 */
export type IdentityPolicy = 'pin' | 'adopt';

/** The caller's own identity for the row, plus the raw side hints a list item may carry. */
export interface ResolvedAddItem {
  title: string;
  author?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  coverUrl?: string | undefined;
  description?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
}

/** Everything a caller contributes that is not identity: who added the row, and under what account. */
export interface ResolvedAddProvenance {
  source: EventSource;
  /** Base reason on every event; the pipeline adds the incumbent id and the review reason. */
  reason: Record<string, unknown>;
  importListId?: number | undefined;
}

export interface ResolvedAddRequest {
  item: ResolvedAddItem;
  identity: IdentityPolicy;
  provenance: ResolvedAddProvenance;
}

/**
 * The narrow event port. `ImportListService` writes events with a raw insert and
 * `SeriesAddAllService` through `EventHistoryService`; injecting the latter into the former would
 * rewrite ~40 test constructions for no behavioural gain, so both back this one function instead.
 */
export interface ResolvedAddEvent {
  bookId: number | null;
  bookTitle: string;
  authorName: string | null;
  eventType: 'book_added' | 'recording_review_skipped';
  source: EventSource;
  reason: Record<string, unknown>;
}

export interface ResolvedAddDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create'>;
  recordEvent: (event: ResolvedAddEvent) => Promise<unknown>;
  /** Optional because `ImportListService.metadata` is: an unconfigured provider creates raw rows. */
  resolver?: Pick<MetadataService, 'resolveBook'> | undefined;
}

/**
 * Rich enough for both callers to map to their own vocabulary without re-deriving it: import lists
 * report `same-recording` and `owned-race` as skipped, Add All reports both as owned.
 * `existingBookId` is nullable only because `findDuplicate`'s resolution type is — a real
 * `same-recording` or `review` verdict always carries its incumbent.
 */
export type ResolvedAddResult =
  // authorName is the primary author the row was created under, which under `adopt` is the
  // resolved one rather than anything the caller holds.
  | { outcome: 'created'; book: BookDetail; authorName: string | null }
  | { outcome: 'same-recording'; existingBookId: number | null }
  | { outcome: 'review'; existingBookId: number | null; recordingReviewReason?: RecordingReviewReason }
  | { outcome: 'owned-race'; existingBookId: number };

/** The row the pipeline will write: caller identity and resolved enrichment, already merged. */
interface ResolvedRow {
  title: string;
  authorName?: string | undefined;
  coverUrl?: string | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  narrators?: string[] | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  productionType?: ProductionType | undefined;
}

/**
 * Kept verbatim: the import-list operator log contract is asserted on this text, and the `adopt`
 * policy has exactly one caller.
 */
const IDENTITY_ADOPTED = 'Import-list metadata disagrees with raw provider fields; adopting resolved metadata';

/**
 * Debug, not warn, unlike its adopt twin: under `pin` a provider title routinely carries a subtitle
 * or series tail the card's does not, so a disagreement is the ordinary case rather than a surprise.
 */
const IDENTITY_PINNED = 'Resolved metadata disagrees with the requested identity; pinning the caller identity';

/**
 * The one resolve → duplicate-check → create → announce pipeline. Both add surfaces that start from
 * a bare title and author run it, so the duplicate check sees the same recording evidence on both
 * and a change to the disposition rules reaches both structurally rather than by promise.
 *
 * The immediate-search trigger deliberately stays with the callers: Add All defers its searches
 * until after the batch and outside its admission guard, and that ordering is load-bearing.
 */
export async function addResolvedBook(
  deps: ResolvedAddDeps,
  request: ResolvedAddRequest,
  log: FastifyBaseLogger,
): Promise<ResolvedAddResult> {
  const { item, identity, provenance } = request;
  const { match, enrichmentStatus } = await resolveMatch(deps, item, identity, log);
  const row = buildRow(item, match, identity);

  const resolution = await deps.bookService.findDuplicate({
    title: row.title,
    ...(row.authorName && { authors: [{ name: row.authorName }] }),
    ...(row.asin !== undefined && { asin: row.asin }),
    ...(row.narrators !== undefined && { narrators: row.narrators }),
    ...(row.duration != null && { duration: row.duration }),
    // Without normalized production type, abridged/unabridged items lacking duration collapse (#1728 F1).
    ...(row.productionType !== undefined && { productionType: row.productionType }),
  });

  if (resolution.verdict === 'same-recording') {
    log.debug({ title: row.title, asin: row.asin }, 'Book already exists (same recording), skipped');
    return { outcome: 'same-recording', existingBookId: resolution.book?.id ?? null };
  }
  if (resolution.verdict === 'review') {
    const existingBookId = resolution.book?.id ?? null;
    const { recordingReviewReason } = resolution;
    // The event IS the durable artifact of a hold, so it is awaited: a caller may not report a hold
    // on mere issuance, and a rejection must reach it as a failure.
    await recordReviewSkip(deps, row, provenance, existingBookId, recordingReviewReason, log);
    return { outcome: 'review', existingBookId, ...(recordingReviewReason && { recordingReviewReason }) };
  }

  return createAndAnnounce(deps, row, enrichmentStatus, provenance, log);
}

/** Preserve `failed` for a genuine no-match only; a provider that failed is not evidence of one. */
async function resolveMatch(
  deps: ResolvedAddDeps,
  item: ResolvedAddItem,
  identity: IdentityPolicy,
  log: FastifyBaseLogger,
): Promise<{ match: BookMetadata | null; enrichmentStatus: 'failed' | undefined }> {
  if (!deps.resolver) return { match: null, enrichmentStatus: undefined };
  try {
    const match = await deps.resolver.resolveBook({
      asin: item.asin,
      title: item.title,
      author: item.author,
    });
    if (match) {
      logIdentityMismatch(item, match, identity, log);
      return { match, enrichmentStatus: undefined };
    }
    // A genuine no-match becomes failed so the one-hour search retry can recover it.
    return { match: null, enrichmentStatus: 'failed' };
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      // Provider failures stay pending; they are not evidence of no match.
      log.warn({ title: item.title, provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Metadata resolution rate limited; leaving book pending');
      return { match: null, enrichmentStatus: undefined };
    }
    if (error instanceof TransientError) {
      log.warn({ title: item.title, provider: error.provider }, 'Metadata resolution hit a transient provider error; leaving book pending');
      return { match: null, enrichmentStatus: undefined };
    }
    log.warn({ title: item.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
    return { match: null, enrichmentStatus: undefined };
  }
}

function logIdentityMismatch(
  item: ResolvedAddItem,
  match: BookMetadata,
  identity: IdentityPolicy,
  log: FastifyBaseLogger,
): void {
  const metadataAuthor = match.authors[0]?.name;
  const titleDiffers = !!item.title && item.title.toLowerCase() !== match.title.toLowerCase();
  const authorDiffers = !!item.author && !!metadataAuthor && item.author.toLowerCase() !== metadataAuthor.toLowerCase();
  if (!titleDiffers && !authorDiffers) return;
  const payload = {
    asin: match.asin ?? item.asin,
    listTitle: item.title,
    metadataTitle: match.title,
    listAuthor: item.author,
    metadataAuthor,
  };
  if (identity === 'adopt') log.warn(payload, IDENTITY_ADOPTED);
  else log.debug(payload, IDENTITY_PINNED);
}

/**
 * Identity comes from the policy; every other field is the resolved match, with the caller's raw
 * hints preferred where it supplied one. With no match the row is the caller's own fields.
 */
function buildRow(item: ResolvedAddItem, match: BookMetadata | null, identity: IdentityPolicy): ResolvedRow {
  if (!match) {
    return {
      title: item.title,
      authorName: item.author,
      coverUrl: item.coverUrl,
      description: item.description,
      seriesName: item.seriesName,
      seriesPosition: item.seriesPosition,
      asin: item.asin,
      isbn: item.isbn,
    };
  }
  return {
    ...resolveIdentity(item, match, identity),
    coverUrl: item.coverUrl ?? match.coverUrl,
    subtitle: match.subtitle,
    description: item.description ?? match.description,
    publisher: match.publisher,
    narrators: match.narrators,
    duration: match.duration,
    publishedDate: match.publishedDate,
    genres: match.genres,
    // Search fallback may replace a print/Kindle ASIN with the resolved audiobook ASIN.
    asin: match.asin ?? item.asin,
    isbn: item.isbn ?? match.isbn,
    // Persist only actual format signal; undefined preserves the DB default (#1731).
    productionType: match.formatType ? normalizeProductionType(match.formatType) : undefined,
  };
}

function resolveIdentity(
  item: ResolvedAddItem,
  match: BookMetadata,
  identity: IdentityPolicy,
): Pick<ResolvedRow, 'title' | 'authorName' | 'seriesName' | 'seriesPosition'> {
  if (identity === 'pin') {
    return {
      title: item.title,
      authorName: item.author,
      seriesName: item.seriesName,
      seriesPosition: item.seriesPosition,
    };
  }
  const primarySeries = pickPrimarySeries(match);
  return {
    title: match.title,
    authorName: match.authors[0]?.name,
    seriesName: primarySeries?.name,
    seriesPosition: primarySeries?.position,
  };
}

/** Neither add surface has a review UI, so the hold lives on the incumbent's history (#1735). */
async function recordReviewSkip(
  deps: ResolvedAddDeps,
  row: ResolvedRow,
  provenance: ResolvedAddProvenance,
  existingBookId: number | null,
  recordingReviewReason: RecordingReviewReason | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  log.info(
    { title: row.title, asin: row.asin, existingBookId, recordingReviewReason },
    'Add needs recording review — recording held-review event',
  );
  await deps.recordEvent({
    bookId: existingBookId,
    bookTitle: row.title,
    authorName: row.authorName ?? null,
    eventType: 'recording_review_skipped',
    source: provenance.source,
    // Unstructured reason JSON preserves the machine downgrade reason without a migration (#1728).
    reason: { ...provenance.reason, existingBookId, ...(recordingReviewReason && { recordingReviewReason }) },
  });
}

async function createAndAnnounce(
  deps: ResolvedAddDeps,
  row: ResolvedRow,
  enrichmentStatus: 'failed' | undefined,
  provenance: ResolvedAddProvenance,
  log: FastifyBaseLogger,
): Promise<ResolvedAddResult> {
  let book: BookDetail;
  try {
    book = await deps.bookService.create({
      title: row.title,
      authors: row.authorName ? [{ name: row.authorName }] : [],
      narrators: row.narrators,
      subtitle: row.subtitle,
      description: row.description,
      publisher: row.publisher,
      coverUrl: row.coverUrl,
      asin: row.asin,
      isbn: row.isbn,
      seriesName: row.seriesName,
      seriesPosition: row.seriesPosition,
      duration: row.duration,
      publishedDate: row.publishedDate,
      genres: row.genres,
      productionType: row.productionType,
      status: 'wanted',
      enrichmentStatus,
      importListId: provenance.importListId,
    });
  } catch (error: unknown) {
    // A same-ASIN create race means another request already owns the recording (#1711).
    if (error instanceof OwnedRecordingError) {
      log.info({ title: row.title, asin: row.asin, existingBookId: error.existingBookId }, 'Book already owned (ASIN race), skipped');
      return { outcome: 'owned-race', existingBookId: error.existingBookId };
    }
    throw error;
  }

  // The committed row is the point of no return, so this rejection is absorbed here and can never
  // reach a caller's failure path.
  void deps.recordEvent({
    bookId: book.id,
    bookTitle: book.title,
    authorName: row.authorName ?? null,
    eventType: 'book_added',
    source: provenance.source,
    reason: provenance.reason,
  }).catch((error: unknown) => log.warn({ bookId: book.id, error: serializeError(error) }, 'Failed to record book_added event'));

  return { outcome: 'created', book, authorName: row.authorName ?? null };
}
