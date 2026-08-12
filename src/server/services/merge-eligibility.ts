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
 * Run the same eligibility checks before enqueue and again on promotion because queued books and
 * their environment can change while waiting.
 */
type MergeCandidate = { title: string; path: string | null; status: string };

function requireMergeableBook<T extends MergeCandidate>(book: T | null): T & { path: string } {
  if (!book) throw new MergeError('Book not found', 'NOT_FOUND');
  if (!book.path) throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
  if (book.status !== 'imported') throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
  return book as T & { path: string };
}

export async function listTopLevelAudioFiles(dir: string): Promise<string[]> {
  const allEntries = await readdir(dir);
  return allEntries.filter((f) => !isHiddenName(f) && AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
}

/** Share one minimum, message, and error code across eligibility and execution. */
export function requireMergeMinimum(topLevelAudioFiles: string[]): void {
  if (topLevelAudioFiles.length < 2) throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
}

async function requireMergeableFolder(bookPath: string): Promise<void> {
  if (!(await resolveFfmpegPath())) throw new MergeError('ffmpeg is not available', 'FFMPEG_NOT_CONFIGURED');
  requireMergeMinimum(await listTopLevelAudioFiles(bookPath));
}

/**
 * Return the settings and title already read so admission needs no second fallible lookup.
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

export async function validateDequeueTime(bookService: Pick<BookService, 'getById'>, bookId: number): Promise<void> {
  const book = requireMergeableBook(await bookService.getById(bookId));
  await requireMergeableFolder(book.path);
}
