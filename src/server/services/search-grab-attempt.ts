import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError, isBookMissingRefusal } from './download-errors.js';
import { buildGrabPayload } from './grab-payload.js';
import { ensureError } from '../utils/ensure-error.js';

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string }
  | { result: 'grab_error'; error: Error };

/**
 * Rejections that are a SKIP rather than a failure.
 *
 * The distinction reaches further than the copy: `sink.grabError` and `recordGrabFailedEvent` both
 * sit on the `grab_error` arm alone, so classifying the book-missing refusal here is what makes
 * the `book_events` FK unreachable for a deleted book rather than merely better-rendered (#2604).
 */
const GRAB_SKIPS: ReadonlyArray<{
  matches: (error: unknown) => boolean;
  reason: string;
  message: string;
}> = [
  {
    matches: (error) => error instanceof DuplicateDownloadError,
    reason: 'grab_blocked',
    message: 'Skipping grab — book already has a blocking download or import',
  },
  {
    matches: isBookMissingRefusal,
    reason: 'book_missing',
    message: 'Skipping grab — book no longer exists',
  },
];

/** Attempts the auto-grab and classifies the outcome; the sink and the event recorder key on it. */
export async function tryGrab(
  best: SearchResult,
  book: { id: number; title: string },
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
): Promise<Exclude<SingleBookSearchResult, { result: 'no_results' }>> {
  try {
    await downloadOrchestrator.grab(buildGrabPayload(best, book.id));
    log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
    return { result: 'grabbed', title: best.title };
  } catch (grabError: unknown) {
    const skip = GRAB_SKIPS.find((candidate) => candidate.matches(grabError));
    if (skip) {
      log.debug({ bookId: book.id, title: book.title }, skip.message);
      return { result: 'skipped', reason: skip.reason };
    }
    return { result: 'grab_error', error: ensureError(grabError) };
  }
}
