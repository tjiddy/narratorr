import type { FastifyBaseLogger } from 'fastify';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';

// ── emitDownloadImporting ────────────────────────────────────────────────

export interface EmitDownloadImportingArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  downloadStatus: string;
  log: FastifyBaseLogger;
}

/** Emit SSE download_status_change for the importing transition. */
export function emitDownloadImporting(args: EmitDownloadImportingArgs): void {
  const { broadcaster, downloadId, bookId, downloadStatus, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('download_status_change', { download_id: downloadId, book_id: bookId, old_status: downloadStatus as DownloadStatus, new_status: 'importing' as DownloadStatus });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitBookImporting ───────────────────────────────────────────────────

export interface EmitBookImportingArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  bookStatus: string;
  log: FastifyBaseLogger;
}

/** Emit SSE book_status_change for the importing transition. */
export function emitBookImporting(args: EmitBookImportingArgs): void {
  const { broadcaster, bookId, bookStatus, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('book_status_change', { book_id: bookId, old_status: bookStatus as BookStatus, new_status: 'importing' as BookStatus });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitImportSuccess ───────────────────────────────────────────────────

export interface EmitImportSuccessArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  bookTitle: string;
  log: FastifyBaseLogger;
}

/** Emit SSE events for successful import. */
export function emitImportSuccess(args: EmitImportSuccessArgs): void {
  const { broadcaster, downloadId, bookId, bookTitle, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('download_status_change', { download_id: downloadId, book_id: bookId, old_status: 'importing' as DownloadStatus, new_status: 'imported' as DownloadStatus });
    broadcaster.emit('book_status_change', { book_id: bookId, old_status: 'importing' as BookStatus, new_status: 'imported' as BookStatus });
    broadcaster.emit('import_complete', { download_id: downloadId, book_id: bookId, book_title: bookTitle });
  } catch (e) {
    log.debug(e, 'SSE emit failed');
  }
}

// ── notifyImportComplete ────────────────────────────────────────────────

export interface NotifyImportCompleteArgs {
  notifierService: NotifierService | undefined;
  bookTitle: string;
  authorName: string | null | undefined;
  targetPath: string;
  fileCount: number;
  log: FastifyBaseLogger;
}

/** Fire-and-forget import notification. */
export function notifyImportComplete(args: NotifyImportCompleteArgs): void {
  const { notifierService, bookTitle, authorName, targetPath, fileCount, log } = args;
  if (!notifierService) return;
  notifierService.notify('on_import', {
    event: 'on_import',
    book: { title: bookTitle, author: authorName ?? undefined },
    import: { libraryPath: targetPath, fileCount },
  }).catch((err: unknown) => log.warn(err, 'Failed to send import notification'));
}

// ── recordImportEvent ───────────────────────────────────────────────────

export interface RecordImportEventArgs {
  eventHistory: EventHistoryService | undefined;
  bookId: number;
  bookTitle: string;
  authorName: string | null | undefined;
  downloadId: number;
  bookPath: string | null;
  targetPath: string;
  fileCount: number;
  totalSize: number;
  log: FastifyBaseLogger;
}

/** Fire-and-forget event recording. */
export function recordImportEvent(args: RecordImportEventArgs): void {
  const { eventHistory, bookId, bookTitle, authorName, downloadId, bookPath, targetPath, fileCount, totalSize, log } = args;
  if (!eventHistory) return;
  const isUpgrade = !!bookPath;
  eventHistory.create({
    bookId,
    bookTitle,
    authorName: authorName ?? undefined,
    downloadId,
    eventType: isUpgrade ? 'upgraded' : 'imported',
    source: 'auto',
    reason: { targetPath, fileCount, totalSize },
  }).catch((err: unknown) => log.warn(err, 'Failed to record import event'));
}

// ── Failure-path side effects ───────────────────────────────────────────

export interface EmitImportFailureArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  revertedBookStatus: string;
  log: FastifyBaseLogger;
}

/** Emit SSE events for a failed import. Fire-and-forget. */
export function emitImportFailure(args: EmitImportFailureArgs): void {
  const { broadcaster, downloadId, bookId, revertedBookStatus, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('download_status_change', { download_id: downloadId, book_id: bookId, old_status: 'importing' as DownloadStatus, new_status: 'failed' as DownloadStatus });
    broadcaster.emit('book_status_change', { book_id: bookId, old_status: 'importing' as BookStatus, new_status: revertedBookStatus as BookStatus });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

export interface NotifyImportFailureArgs {
  notifierService: NotifierService | undefined;
  downloadTitle: string;
  error: unknown;
  log: FastifyBaseLogger;
}

/** Fire-and-forget failure notification. */
export function notifyImportFailure(args: NotifyImportFailureArgs): void {
  const { notifierService, downloadTitle, error, log } = args;
  if (!notifierService) return;
  notifierService.notify('on_failure', {
    event: 'on_failure',
    book: { title: downloadTitle },
    error: { message: error instanceof Error ? error.message : 'Import failed', stage: 'import' },
  }).catch((err: unknown) => log.warn(err, 'Failed to send failure notification'));
}

export interface RecordImportFailedEventArgs {
  eventHistory: EventHistoryService | undefined;
  bookId: number;
  bookTitle: string;
  authorName: string | null | undefined;
  downloadId: number;
  error: unknown;
  log: FastifyBaseLogger;
}

/** Fire-and-forget failure event recording. */
export function recordImportFailedEvent(args: RecordImportFailedEventArgs): void {
  const { eventHistory, bookId, bookTitle, authorName, downloadId, error, log } = args;
  if (!eventHistory) return;
  eventHistory.create({
    bookId,
    bookTitle,
    authorName: authorName ?? undefined,
    downloadId,
    eventType: 'import_failed',
    source: 'auto',
    reason: { error: error instanceof Error ? error.message : 'Import failed' },
  }).catch((err: unknown) => log.warn(err, 'Failed to record import_failed event'));
}
