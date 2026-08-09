import type { FastifyBaseLogger } from 'fastify';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { DuplicateVerdict } from './book-dedup.js';
import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import type { BookService, BookDetail } from './book.service.js';
import type { CreateBookInput } from './book-create.js';
import type { EventHistoryService } from './event-history.service.js';

export interface AddBookLadderDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create' | 'getById'>;
  eventHistory: Pick<EventHistoryService, 'create'>;
}

export type AddBookLadderResult =
  | {
      outcome: 'duplicate';
      verdict: Exclude<DuplicateVerdict, 'different-recording'>;
      book: BookDetail;
      recordingReviewReason?: RecordingReviewReason;
    }
  | { outcome: 'owned-race'; existingBookId: number; book: BookDetail | null }
  | { outcome: 'created'; book: BookDetail };

/**
 * The one duplicate → create → announce ladder. `POST /api/books` and the Series-card batch both run
 * it so a change to duplicate handling reaches both surfaces structurally rather than by promise.
 */
export async function addBookThroughLadder(
  deps: AddBookLadderDeps,
  input: CreateBookInput,
  log: FastifyBaseLogger,
): Promise<AddBookLadderResult> {
  // Block owned or uncertain recordings; a confirmed different recording is a valid keep-both.
  const resolution = await deps.bookService.findDuplicate({
    title: input.title,
    authors: input.authors,
    ...(input.asin !== undefined && { asin: input.asin }),
    ...(input.narrators !== undefined && { narrators: input.narrators }),
    ...(input.duration !== undefined && { duration: input.duration }),
  });
  if (resolution.verdict !== 'different-recording' && resolution.book) {
    log.info({ title: input.title, existingId: resolution.book.id, verdict: resolution.verdict }, 'Duplicate book detected');
    return {
      outcome: 'duplicate',
      verdict: resolution.verdict,
      book: resolution.book,
      ...(resolution.recordingReviewReason && { recordingReviewReason: resolution.recordingReviewReason }),
    };
  }

  let book: BookDetail;
  try {
    book = await deps.bookService.create(input);
  } catch (error: unknown) {
    // A same-ASIN create race means another request already owns the recording.
    if (error instanceof OwnedRecordingError) {
      log.info({ title: input.title, existingId: error.existingBookId }, 'Duplicate book detected (ASIN race)');
      return { outcome: 'owned-race', existingBookId: error.existingBookId, book: await deps.bookService.getById(error.existingBookId) };
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
