import type { FastifyBaseLogger } from 'fastify';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import type { ProductionType } from '@shared/schemas/book.js';
import type { EventSource } from '@shared/schemas/event-history.js';
import { snapshotBookForEvent } from '../../utils/event-helpers.js';
import { serializeError } from '../../utils/serialize-error.js';
import { OwnedRecordingError } from '../book-dedup.js';
import type { DuplicateVerdict } from '../book-dedup.js';
import type { CreateBookInput } from '../book-create.js';
import type { BookDetail, BookService, BookWithAuthor } from '../book.service.js';
import type { MetadataService } from '../metadata.service.js';
import { decideIntake } from './decide-intake.js';
import { enrichAsinBeforeDecision, type AsinEnrichmentDeps } from './enrich-asin.js';
import { buildResolvedItem, type AddBookSeed, type IdentityPolicy } from './resolve.js';
import type { IntakeDecision, IntakeItem } from './types.js';

/**
 * The write-side item: the whole create payload plus the one wire field that is not a column.
 *
 * It CONTAINS an `IntakeItem` rather than extending one. `interface AddBookItem extends
 * CreateBookInput, IntakeItem` does not compile: the two disagree on `authors` (required vs
 * optional), `duration` (`number` vs `number | null`) and `productionType` (`ProductionType` vs
 * `string | null`). `toIntakeItem` below is the single place the decision half is derived.
 */
export interface AddBookItem extends CreateBookInput {
  /** Raw provider format. Normalized ONCE into the `productionType` that feeds both the duplicate
   * candidate and the create payload, and never forwarded — there is no column behind it. */
  formatType?: string | null | undefined;
}

/**
 * Which `book_added` payload to write. Two shapes exist and one type cannot silently pick a winner:
 * `snapshot` is `snapshotBookForEvent`'s — every author joined with `', '`, a `narratorName`, no
 * `reason`. `resolved` is the bulk callers' — the primary author and a `reason`, no `narratorName`.
 */
export type AddBookEventShape = 'snapshot' | 'resolved';

/** Who is adding the row, and in which announcement shape. */
export interface AddBookProvenance {
  source: EventSource;
  /** Belongs to the `resolved` shape; the snapshot payload has no reason field. */
  reason?: Record<string, unknown> | undefined;
  eventShape: AddBookEventShape;
  /** Stamped onto a resolved row so the library can name the list that introduced it. */
  importListId?: number | undefined;
}

/**
 * The narrow event port. `ImportListService` writes events with a raw insert and the other two add
 * surfaces through `EventHistoryService`; injecting the latter into the former would rewrite ~40
 * test constructions for no behavioural gain, so all three back this one function instead.
 */
export interface AddBookEvent {
  bookId: number | null;
  bookTitle: string;
  authorName: string | null;
  narratorName?: string | null | undefined;
  eventType: 'book_added' | 'recording_review_skipped';
  source: EventSource;
  reason?: Record<string, unknown> | undefined;
}

/**
 * What the caller wants done with an undecided `review` verdict. Three behaviours exist across the
 * add surfaces and two names cannot hold them.
 * - `refuse` — report the conflict and write nothing. A review is an abstention, not an ownership
 *   claim, so it leaves no trace on the incumbent's history.
 * - `override` — the same caller when the request explicitly asked: admit the row anyway.
 * - `record-and-hold` — the bulk callers' rule: a `recording_review_skipped` event, then skip.
 */
export type AddBookOnReview = 'refuse' | 'record-and-hold' | 'override';

interface AddBookRequestBase {
  onReview: AddBookOnReview;
  provenance: AddBookProvenance;
}

/**
 * A union rather than one shape with optional halves: a caller either already holds the whole write
 * item or holds only a seed the resolver must widen, and there is no third state. Modelling it this
 * way makes "a seed with no resolve step" and "an identity policy with nothing to resolve"
 * unrepresentable instead of runtime-checked.
 */
export type AddBookRequest =
  | (AddBookRequestBase & { resolve: 'skip'; item: AddBookItem })
  | (AddBookRequestBase & { resolve: 'required'; seed: AddBookSeed; identity: IdentityPolicy });

/**
 * Whether the item must be resolved against the metadata provider before the decision.
 * - `skip` — the caller already holds a `BookMetadata` (its client searched first), so resolving
 *   again would be a wasted provider call.
 * - `required` — the bulk callers start from a bare title and author.
 *
 * DERIVED from the arms, not spelled again, so the arm set has exactly one home. As an independent
 * literal union it drifted silently in both directions: a name could sit here with no request arm
 * behind it, and nothing — not even the negative type suite — would see the orphan.
 */
export type AddBookResolve = AddBookRequest['resolve'];

export interface AddBookDeps extends AsinEnrichmentDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create' | 'getById'>;
  eventHistory: { create: (event: AddBookEvent) => Promise<unknown> };
  /** Only the `resolve: 'required'` arm reads it, and only when the operator configured one. */
  resolver?: Pick<MetadataService, 'resolveBook'> | undefined;
}

export type AddBookResult =
  | {
      outcome: 'duplicate';
      verdict: Exclude<DuplicateVerdict, 'different-recording'>;
      // Nullable for the `record-and-hold` callers only; see `refuseDuplicate`.
      book: BookWithAuthor | null;
      existingBookId: number | null;
      recordingReviewReason?: RecordingReviewReason;
    }
  // bookTitle is the identity floor: hydration is best-effort, so `book` may be null.
  | { outcome: 'owned-race'; existingBookId: number; bookTitle: string; book: BookDetail | null }
  // authorName is the primary author the row was created under, which under `adopt` is the resolved
  // one rather than anything the caller holds — and what its own search trigger must key on.
  | { outcome: 'created'; book: BookDetail; authorName: string | null };

type DuplicateResult = Extract<AddBookResult, { outcome: 'duplicate' }>;

/** The single place the decision half is derived from the write item. Undefined values survive as
 * undefined: `buildDuplicateCandidate` is what turns them back into omitted keys. */
function toIntakeItem(item: AddBookItem, productionType: ProductionType | undefined): IntakeItem {
  return {
    title: item.title,
    authors: item.authors,
    asin: item.asin,
    narrators: item.narrators,
    duration: item.duration,
    productionType,
  };
}

function primaryAuthorOf(item: AddBookItem): string | null {
  return item.authors[0]?.name ?? null;
}

/**
 * The decision the caller's policy makes of the verdict, or `null` to admit the row.
 *
 * A verdict carrying NO incumbent admits for the 409 surfaces: `decideIntake` types `incumbent` as
 * nullable, the 409 body spreads the incumbent row at top level, and refusing there would answer
 * `{ conflict }` with no `id` and no `title`. The bulk callers report a bare incumbent id into a
 * per-item disposition instead, so `record-and-hold` reports the duplicate either way.
 */
function refuseDuplicate(
  decision: IntakeDecision,
  onReview: AddBookOnReview,
  item: AddBookItem,
  log: FastifyBaseLogger,
): DuplicateResult | null {
  if (decision.kind === 'admit') return null;
  if (!decision.incumbent && onReview !== 'record-and-hold') return null;

  // Only the undecided arm is overridable: same-recording is a conclusion, review is an abstention.
  if (decision.kind === 'review' && onReview === 'override') {
    log.info({ title: item.title, existingId: decision.existingBookId }, 'Recording review overridden by request');
    return null;
  }

  if (decision.kind === 'same-recording') {
    logSameRecording(onReview, item, decision.existingBookId, log);
    return {
      outcome: 'duplicate', verdict: 'same-recording', book: decision.incumbent, existingBookId: decision.existingBookId,
    };
  }
  // The record-and-hold arm's own log is the one that names the durable artifact it is about to write.
  if (onReview !== 'record-and-hold') {
    log.info({ title: item.title, existingId: decision.existingBookId, verdict: decision.kind }, 'Duplicate book detected');
  }
  return {
    outcome: 'duplicate',
    verdict: 'review',
    book: decision.incumbent,
    existingBookId: decision.existingBookId,
    ...(decision.recordingReviewReason && { recordingReviewReason: decision.recordingReviewReason }),
  };
}

/**
 * A bulk skip is routine bookkeeping over a list the operator never enumerated, so it stays at
 * debug; a 409 surface answers a request the operator made by hand and records every refusal.
 */
function logSameRecording(
  onReview: AddBookOnReview,
  item: AddBookItem,
  existingId: number | null,
  log: FastifyBaseLogger,
): void {
  if (onReview === 'record-and-hold') {
    log.debug({ title: item.title, asin: item.asin, existingId }, 'Book already exists (same recording), skipped');
    return;
  }
  log.info({ title: item.title, existingId, verdict: 'same-recording' }, 'Duplicate book detected');
}

/** Neither bulk add surface has a review UI, so the hold lives on the incumbent's history (#1735). */
async function recordReviewHold(
  deps: AddBookDeps,
  item: AddBookItem,
  provenance: AddBookProvenance,
  refusal: DuplicateResult,
  log: FastifyBaseLogger,
): Promise<void> {
  const { existingBookId, recordingReviewReason } = refusal;
  log.info(
    { title: item.title, asin: item.asin, existingBookId, recordingReviewReason },
    'Add needs recording review — recording held-review event',
  );
  await deps.eventHistory.create({
    bookId: existingBookId,
    bookTitle: item.title,
    authorName: primaryAuthorOf(item),
    eventType: 'recording_review_skipped',
    source: provenance.source,
    // Unstructured reason JSON preserves the machine downgrade reason without a migration (#1728).
    reason: { ...provenance.reason, existingBookId, ...(recordingReviewReason && { recordingReviewReason }) },
  });
}

/** Enrichment only — a rejected or empty read must not turn a committed collision into a 500. */
async function hydrateRaceIncumbent(
  deps: AddBookDeps,
  existingBookId: number,
  log: FastifyBaseLogger,
): Promise<BookDetail | null> {
  try {
    return await deps.bookService.getById(existingBookId);
  } catch (error: unknown) {
    log.warn({ existingId: existingBookId, error: serializeError(error) }, 'Failed to hydrate the owned-race incumbent');
    return null;
  }
}

function buildAddedEvent(item: AddBookItem, book: BookDetail, provenance: AddBookProvenance): AddBookEvent {
  if (provenance.eventShape === 'snapshot') {
    return { bookId: book.id, ...snapshotBookForEvent(book), eventType: 'book_added', source: provenance.source };
  }
  // No narratorName key at all, and the caller's reason verbatim: the shape the bulk event
  // consumers have always read.
  return {
    bookId: book.id,
    bookTitle: book.title,
    authorName: primaryAuthorOf(item),
    eventType: 'book_added',
    source: provenance.source,
    reason: provenance.reason ?? {},
  };
}

/**
 * The write item minus the two fields no column stands behind. `formatType` always goes;
 * `providerId` goes only once the provider has been asked, because it is the key
 * `BookService.resolveCreateInput` re-fetches from, and a second fetch would be a wasted provider
 * call against an answer this add already has. When no lookup was attempted the key is forwarded
 * verbatim — key-absent stays key-absent — so that late enrichment still runs for the callers the
 * precondition excludes.
 */
function toCreateInput(item: AddBookItem, lookupAttempted: boolean): CreateBookInput {
  const { formatType: _formatType, providerId, ...rest } = item;
  return lookupAttempted ? rest : { ...rest, ...(providerId !== undefined && { providerId }) };
}

async function createAndAnnounce(
  deps: AddBookDeps,
  item: AddBookItem,
  productionType: ProductionType | undefined,
  provenance: AddBookProvenance,
  lookupAttempted: boolean,
  log: FastifyBaseLogger,
): Promise<AddBookResult> {
  const createInput = toCreateInput(item, lookupAttempted);

  let book: BookDetail;
  try {
    book = await deps.bookService.create({ ...createInput, ...(productionType !== undefined && { productionType }) });
  } catch (error: unknown) {
    // A same-ASIN create race means another request already owns the recording.
    if (error instanceof OwnedRecordingError) {
      log.info({ title: item.title, existingId: error.existingBookId }, 'Duplicate book detected (ASIN race)');
      return {
        outcome: 'owned-race',
        existingBookId: error.existingBookId,
        bookTitle: error.bookTitle,
        book: await hydrateRaceIncumbent(deps, error.existingBookId, log),
      };
    }
    throw error;
  }

  // The committed row is the point of no return, so this rejection is absorbed here and can never
  // reach a caller's failure path — the exact opposite of the awaited hold above.
  deps.eventHistory.create(buildAddedEvent(item, book, provenance))
    .catch((err: unknown) => log.warn({ bookId: book.id, error: serializeError(err) }, 'Failed to record book_added event'));

  log.info({ title: item.title }, 'Book added');
  return { outcome: 'created', book, authorName: primaryAuthorOf(item) };
}

/** The write item, resolved against the provider first when the caller holds only a seed. */
async function toWriteItem(deps: AddBookDeps, request: AddBookRequest, log: FastifyBaseLogger): Promise<AddBookItem> {
  if (request.resolve === 'skip') return request.item;
  return buildResolvedItem(deps, request.seed, request.identity, request.provenance.importListId, log);
}

/**
 * The one resolve → decide → create → announce write path for every add surface. `decideIntake`
 * owns the duplicate/recording verdict; everything here is what the caller's policy does with it.
 *
 * The immediate-search trigger deliberately stays with the callers: Add All defers its searches
 * until after the batch and outside its admission guard, and that ordering is load-bearing.
 */
export async function addBook(
  deps: AddBookDeps,
  request: AddBookRequest,
  log: FastifyBaseLogger,
): Promise<AddBookResult> {
  const { provenance } = request;
  const written = await toWriteItem(deps, request, log);

  // Before the decision, not after the create: the duplicate check must key on the same ASIN the
  // row will carry, or it decides on evidence the row then contradicts (#2249). The
  // `resolve: 'required'` arm never reaches the provider here — `buildResolvedItem` emits no
  // `providerId`, so its items fail the precondition outright.
  const { item, attempted: lookupAttempted } = await enrichAsinBeforeDecision(deps, written, log);

  // Normalized before the decision item is derived, not inside `decideIntake` and not twice:
  // `IntakeItem.productionType` is documented as already canonical. An absent formatType leaves
  // whatever productionType the resolve step (or a non-wire caller) settled, which for the wire
  // callers is nothing.
  const productionType = item.formatType === undefined
    ? item.productionType
    : normalizeProductionType(item.formatType);

  const decision = await decideIntake(deps, { item: toIntakeItem(item, productionType) });
  const refusal = refuseDuplicate(decision, request.onReview, item, log);
  if (refusal) {
    // The event IS the durable artifact of a hold, so it is awaited: a caller may not report a hold
    // on mere issuance, and a rejection must reach it as a failure.
    if (refusal.verdict === 'review' && request.onReview === 'record-and-hold') {
      await recordReviewHold(deps, item, provenance, refusal, log);
    }
    return refusal;
  }

  return createAndAnnounce(deps, item, productionType, provenance, lookupAttempted, log);
}
