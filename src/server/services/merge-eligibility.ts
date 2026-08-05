import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';

export class MergeError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'NO_STATUS' | 'NO_TOP_LEVEL_FILES' | 'FFMPEG_NOT_CONFIGURED' | 'ALREADY_IN_PROGRESS' | 'ALREADY_QUEUED',
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

/**
 * Merge eligibility — the checks a book must pass to be merged, run at BOTH gates: once before a
 * request is accepted, and again when a queued merge is promoted, because the world moves while a
 * book waits in the queue (it gets deleted, its folder loses a file, ffmpeg goes away). The two
 * gates share these helpers so they cannot drift apart, while each keeps its own read of the book
 * — re-reading at promotion is the entire point of the second gate.
 */
type MergeCandidate = { title: string; path: string | null; status: string };

/** The row-level checks: the book exists, is imported, and has a folder. */
function requireMergeableBook<T extends MergeCandidate>(book: T | null): T & { path: string } {
  if (!book) throw new MergeError('Book not found', 'NOT_FOUND');
  if (!book.path) throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
  if (book.status !== 'imported') throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
  return book as T & { path: string };
}

/** Top-level, non-hidden audio entries of a folder — the exact set a merge would consume. */
export async function listTopLevelAudioFiles(dir: string): Promise<string[]> {
  const allEntries = await readdir(dir);
  return allEntries.filter((f) => !isHiddenName(f) && AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
}

/**
 * The merge minimum (≥2 top-level audio files), shared by the eligibility gates and
 * `executeMerge`'s post-recovery recheck (#2142) so a book accepted at enqueue can never fail
 * mid-execution with a divergent threshold, message, or error code.
 */
export function requireMergeMinimum(topLevelAudioFiles: string[]): void {
  if (topLevelAudioFiles.length < 2) throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
}

/** The environment checks: ffmpeg is available and the folder still holds ≥2 visible audio files. */
async function requireMergeableFolder(bookPath: string): Promise<void> {
  if (!(await resolveFfmpegPath())) throw new MergeError('ffmpeg is not available', 'FFMPEG_NOT_CONFIGURED');
  requireMergeMinimum(await listTopLevelAudioFiles(bookPath));
}

/**
 * Pre-enqueue validation: throws MergeError for invalid requests. Duplicate checks live in
 * `enqueueMerge` (synchronous). Returns the processing settings it already fetched so the caller
 * can size the semaphore without a second (rejection-prone) read, plus the title of the book it
 * loaded so the caller can seed the `merge_state` snapshot (#2129) without another book read.
 */
export async function validateBookForMerge(
  bookService: Pick<BookService, 'getById'>,
  settingsService: Pick<SettingsService, 'get'>,
  bookId: number,
): Promise<{ processing: AppSettings['processing']; title: string }> {
  const book = requireMergeableBook(await bookService.getById(bookId));
  const processing = await settingsService.get('processing');
  await requireMergeableFolder(book.path);
  return { processing, title: book.title };
}

/** Dequeue-time validation — the same checks against the world as it is at promotion. */
export async function validateDequeueTime(bookService: Pick<BookService, 'getById'>, bookId: number): Promise<void> {
  const book = requireMergeableBook(await bookService.getById(bookId));
  await requireMergeableFolder(book.path);
}
