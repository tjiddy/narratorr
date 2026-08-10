import type { FastifyBaseLogger } from 'fastify';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { DuplicateVerdict } from './book-dedup.js';
import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import type { BookService, BookDetail, BookWithAuthor } from './book.service.js';
import type { CreateBookInput } from './book-create.js';
import type { EventHistoryService } from './event-history.service.js';

export interface AddBookLadderDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create' | 'getById'>;
  eventHistory: Pick<EventHistoryService, 'create'>;
}

/** The create payload plus the two transient add-surface inputs that are never columns. */
export interface AddBookLadderInput extends CreateBookInput {
  /** Raw provider format; normalized here for both the duplicate veto and the stored row. */
  formatType?: string | null | undefined;
  /** Overrides an undecided `review` verdict only; `same-recording` and races stay refused. */
  overrideRecordingReview?: boolean | undefined;
}

export type AddBookLadderResult =
  | {
      outcome: 'duplicate';
      verdict: Exclude<DuplicateVerdict, 'different-recording'>;
      book: BookWithAuthor;
      recordingReviewReason?: RecordingReviewReason;
    }
  // bookTitle is the identity floor: hydration is best-effort, so `book` may be null.
  | { outcome: 'owned-race'; existingBookId: number; bookTitle: string; book: BookDetail | null }
  | { outcome: 'created'; book: BookDetail };

/** Enrichment only — a rejected or empty read must not turn a committed collision into a 500. */
async function hydrateRaceIncumbent(
  deps: AddBookLadderDeps,
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

/**
 * The duplicate → create → announce ladder for the add surfaces that already hold a `BookMetadata`:
 * `POST /api/books`, whose client searched for the book first. Surfaces that start from a bare title
 * run `addResolvedBook` instead, which is this ladder with a resolve step in front of it; reconciling
 * the two is deliberately a follow-up to #2231 rather than a rider on it.
 */
export async function addBookThroughLadder(
  deps: AddBookLadderDeps,
  input: AddBookLadderInput,
  log: FastifyBaseLogger,
): Promise<AddBookLadderResult> {
  // An absent formatType must stay absent rather than become a no-signal `unknown`, so the resolver
  // and the row keep whatever productionType a non-wire caller already resolved.
  const productionType = input.formatType === undefined
    ? input.productionType
    : normalizeProductionType(input.formatType);

  // Block owned or uncertain recordings; a confirmed different recording is a valid keep-both.
  const resolution = await deps.bookService.findDuplicate({
    title: input.title,
    authors: input.authors,
    ...(input.asin !== undefined && { asin: input.asin }),
    ...(input.narrators !== undefined && { narrators: input.narrators }),
    ...(input.duration !== undefined && { duration: input.duration }),
    ...(productionType !== undefined && { productionType }),
  });
  if (resolution.verdict !== 'different-recording' && resolution.book) {
    // Only the undecided arm is overridable: same-recording is a conclusion, review is an abstention.
    if (resolution.verdict === 'review' && input.overrideRecordingReview) {
      log.info({ title: input.title, existingId: resolution.book.id }, 'Recording review overridden by request');
    } else {
      log.info({ title: input.title, existingId: resolution.book.id, verdict: resolution.verdict }, 'Duplicate book detected');
      return {
        outcome: 'duplicate',
        verdict: resolution.verdict,
        book: resolution.book,
        ...(resolution.recordingReviewReason && { recordingReviewReason: resolution.recordingReviewReason }),
      };
    }
  }

  // The transient flags are dropped here; only columns reach the insert.
  const { formatType: _formatType, overrideRecordingReview: _override, ...createInput } = input;

  let book: BookDetail;
  try {
    book = await deps.bookService.create({ ...createInput, ...(productionType !== undefined && { productionType }) });
  } catch (error: unknown) {
    // A same-ASIN create race means another request already owns the recording.
    if (error instanceof OwnedRecordingError) {
      log.info({ title: input.title, existingId: error.existingBookId }, 'Duplicate book detected (ASIN race)');
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
  // reach a caller's failure path.
  deps.eventHistory.create({
    bookId: book.id,
    ...snapshotBookForEvent(book),
    eventType: 'book_added',
    source: 'manual',
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

  log.info({ title: input.title }, 'Book added');
  return { outcome: 'created', book };
}
