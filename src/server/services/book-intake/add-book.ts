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
import type { EventHistoryService } from '../event-history.service.js';
import { decideIntake } from './decide-intake.js';
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
 * `reason`. `resolved` is `ResolvedAddEvent`'s — the primary author and a `reason`, no
 * `narratorName`. Only `snapshot` is implemented here.
 */
export type AddBookEventShape = 'snapshot' | 'resolved';

/** Who is adding the row, and in which announcement shape. */
export interface AddBookProvenance {
  source: EventSource;
  /** Belongs to the `resolved` shape; the snapshot payload has no reason field. */
  reason?: Record<string, unknown> | undefined;
  eventShape: AddBookEventShape;
}

/**
 * What the caller wants done with an undecided `review` verdict. Three behaviours exist across the
 * add surfaces and two names cannot hold them.
 * - `refuse` — report the conflict and write nothing. A review is an abstention, not an ownership
 *   claim, so it leaves no trace on the incumbent's history.
 * - `override` — the same caller when the request explicitly asked: admit the row anyway.
 * - `record-and-hold` — the bulk callers' rule: a `recording_review_skipped` event, then skip.
 *   Named for the port that lands it; not implemented here.
 */
export type AddBookOnReview = 'refuse' | 'record-and-hold' | 'override';

/**
 * Whether the item must be resolved against the metadata provider before the decision.
 * - `skip` — the caller already holds a `BookMetadata` (its client searched first), so resolving
 *   again would be a wasted provider call.
 * - `required` — the bulk callers start from a bare title. Not implemented here.
 */
export type AddBookResolve = 'required' | 'skip';

export interface AddBookRequest {
  item: AddBookItem;
  onReview: AddBookOnReview;
  resolve: AddBookResolve;
  provenance: AddBookProvenance;
}

export interface AddBookDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create' | 'getById'>;
  eventHistory: Pick<EventHistoryService, 'create'>;
}

export type AddBookResult =
  | {
      outcome: 'duplicate';
      verdict: Exclude<DuplicateVerdict, 'different-recording'>;
      book: BookWithAuthor;
      recordingReviewReason?: RecordingReviewReason;
    }
  // bookTitle is the identity floor: hydration is best-effort, so `book` may be null.
  | { outcome: 'owned-race'; existingBookId: number; bookTitle: string; book: BookDetail | null }
  | { outcome: 'created'; book: BookDetail };

/** Raised for a policy arm that is named in the union but has no implementation behind it yet. */
export class UnimplementedAddPolicyError extends Error {
  constructor(policy: string) {
    super(`addBook does not implement ${policy} yet`);
    this.name = 'UnimplementedAddPolicyError';
  }
}

/**
 * The named-but-unbuilt arms are rejected AT RUNTIME, before any read or write, rather than being
 * hidden behind a narrowed parameter type. Type-level-only was the alternative and was rejected: a
 * single `as` erases it, and these arms are exactly what a future bulk-caller port reaches for. Each
 * axis is switched exhaustively, so a fourth value fails `satisfies never` at compile time.
 */
function assertImplementedPolicy({ onReview, resolve, provenance }: AddBookRequest): void {
  switch (resolve) {
    case 'skip': break;
    case 'required': throw new UnimplementedAddPolicyError("resolve: 'required'");
    default: return resolve satisfies never;
  }
  switch (provenance.eventShape) {
    case 'snapshot': break;
    case 'resolved': throw new UnimplementedAddPolicyError("provenance.eventShape: 'resolved'");
    default: return provenance.eventShape satisfies never;
  }
  switch (onReview) {
    case 'refuse':
    case 'override': break;
    case 'record-and-hold': throw new UnimplementedAddPolicyError("onReview: 'record-and-hold'");
    default: return onReview satisfies never;
  }
}

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

/**
 * The decision the caller's policy makes of the verdict, or `null` to admit the row.
 *
 * A verdict carrying NO incumbent admits: `decideIntake` types `incumbent` as nullable, and the 409
 * body spreads the incumbent row at top level, so refusing there would answer `{ conflict }` with no
 * `id` and no `title`.
 */
function refuseDuplicate(
  decision: IntakeDecision,
  onReview: AddBookOnReview,
  title: string,
  log: FastifyBaseLogger,
): AddBookResult | null {
  if (decision.kind === 'admit' || !decision.incumbent) return null;

  // Only the undecided arm is overridable: same-recording is a conclusion, review is an abstention.
  if (decision.kind === 'review' && onReview === 'override') {
    log.info({ title, existingId: decision.incumbent.id }, 'Recording review overridden by request');
    return null;
  }

  log.info({ title, existingId: decision.incumbent.id, verdict: decision.kind }, 'Duplicate book detected');
  if (decision.kind === 'same-recording') {
    return { outcome: 'duplicate', verdict: 'same-recording', book: decision.incumbent };
  }
  return {
    outcome: 'duplicate',
    verdict: 'review',
    book: decision.incumbent,
    ...(decision.recordingReviewReason && { recordingReviewReason: decision.recordingReviewReason }),
  };
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

async function createAndAnnounce(
  deps: AddBookDeps,
  item: AddBookItem,
  productionType: ProductionType | undefined,
  provenance: AddBookProvenance,
  log: FastifyBaseLogger,
): Promise<AddBookResult> {
  // `formatType` is the item's only non-column, so naming it here is the whole strip.
  const { formatType: _formatType, ...createInput } = item;

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

  // Only the snapshot shape is reachable; `assertImplementedPolicy` refused the other before any I/O.
  // The committed row is the point of no return, so this rejection is absorbed here and can never
  // reach a caller's failure path.
  deps.eventHistory.create({
    bookId: book.id,
    ...snapshotBookForEvent(book),
    eventType: 'book_added',
    source: provenance.source,
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

  log.info({ title: item.title }, 'Book added');
  return { outcome: 'created', book };
}

/**
 * The decide → create → announce write path, for the add surfaces that already hold a
 * `BookMetadata`: `POST /api/books`, whose client searched for the book first. `decideIntake` owns
 * the duplicate/recording verdict; everything here is what the caller's policy does with it.
 */
export async function addBook(
  deps: AddBookDeps,
  request: AddBookRequest,
  log: FastifyBaseLogger,
): Promise<AddBookResult> {
  assertImplementedPolicy(request);
  const { item, provenance } = request;

  // Normalized before the decision item is derived, not inside `decideIntake` and not twice:
  // `IntakeItem.productionType` is documented as already canonical. An absent formatType leaves
  // whatever productionType a non-wire caller resolved, which for the wire callers is nothing.
  const productionType = item.formatType === undefined
    ? item.productionType
    : normalizeProductionType(item.formatType);

  const decision = await decideIntake(deps, { item: toIntakeItem(item, productionType) });
  const refusal = refuseDuplicate(decision, request.onReview, item.title, log);
  if (refusal) return refusal;

  return createAndAnnounce(deps, item, productionType, provenance, log);
}
