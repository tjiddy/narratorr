import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { writeOpfSidecar, type OpfWriteOutcome } from './opf-writer.js';
import { serializeError } from './serialize-error.js';

export interface RefreshOpfForBookArgs {
  settingsService: SettingsService;
  bookService: BookService;
  bookId: number;
  /** Null for a book not yet imported. */
  bookFolder: string | null;
  log: FastifyBaseLogger;
}

/**
 * Refresh a per-book sidecar after metadata mutation. This follows `tagging.writeOpf`, remains
 * independent of audio re-tagging, is nonfatal, and exposes the write outcome to callers.
 */
export async function refreshOpfForBook(args: RefreshOpfForBookArgs): Promise<OpfWriteOutcome> {
  const { settingsService, bookService, bookId, bookFolder, log } = args;
  if (!bookFolder) return 'skipped';

  try {
    const tagging = await settingsService.get('tagging');
    return await writeOpfSidecar({ enabled: tagging.writeOpf, bookService, bookId, bookFolder, log });
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to refresh metadata.opf after edit — continuing');
    return 'failed';
  }
}
