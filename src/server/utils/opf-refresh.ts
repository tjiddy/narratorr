import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { writeOpfForImport } from './opf-writer.js';
import { serializeError } from './serialize-error.js';

export interface RefreshOpfForBookArgs {
  settingsService: SettingsService;
  bookService: BookService;
  bookId: number;
  /** The book's on-disk folder. `null` for a not-yet-imported book → explicit skip (no null join). */
  bookFolder: string | null;
  log: FastifyBaseLogger;
}

/**
 * Refresh a book's `metadata.opf` sidecar after a metadata-changing edit (PUT, Fix Match, cover
 * upload). Gated ONLY on the global `tagging.writeOpf` setting — deliberately independent of the
 * per-request `retagFiles`/audio-retag opt-in, so an edited book's OPF never drifts from the DB.
 *
 * Best-effort and nonfatal: a not-imported book (`bookFolder === null`) is skipped BEFORE the writer
 * is called (passing a null folder would `join(undefined, …)` a stray file into the process CWD), and
 * any failure is logged and swallowed so the edit/upload response still succeeds. Lives in its own
 * module (not alongside `writeOpfForImport`) so route/service tests can spy on the writer export.
 */
export async function refreshOpfForBook(args: RefreshOpfForBookArgs): Promise<void> {
  const { settingsService, bookService, bookId, bookFolder, log } = args;
  if (!bookFolder) return; // not imported — never call the writer with a null folder

  try {
    const tagging = await settingsService.get('tagging');
    await writeOpfForImport({ enabled: tagging.writeOpf, bookService, bookId, bookFolder, log });
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to refresh metadata.opf after edit — continuing');
  }
}
