import type { FastifyBaseLogger } from 'fastify';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { fireAndForget } from './fire-and-forget.js';
import { getErrorMessage } from './error-message.js';
import { safeEmit } from './safe-emit.js';
import { serializeError } from './serialize-error.js';

export interface EmitDownloadImportingArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  downloadStatus: DownloadStatus;
  log: FastifyBaseLogger;
}

export function emitDownloadImporting(args: EmitDownloadImportingArgs): void {
  const { broadcaster, downloadId, bookId, downloadStatus, log } = args;
  safeEmit(broadcaster, 'download_status_change', { download_id: downloadId, book_id: bookId, old_status: downloadStatus, new_status: 'importing' }, log);
}

export interface EmitBookImportingArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  bookStatus: BookStatus;
  log: FastifyBaseLogger;
}

export function emitBookImporting(args: EmitBookImportingArgs): void {
  const { broadcaster, bookId, bookStatus, log } = args;
  if (bookStatus === 'importing') return;
  safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: bookStatus, new_status: 'importing' }, log);
}

export interface EmitImportStatusSuccessArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  log: FastifyBaseLogger;
}

// Each status emit is isolated; import_complete belongs to ImportQueueWorker (#1108).
export function emitImportStatusSuccess(args: EmitImportStatusSuccessArgs): void {
  const { broadcaster, downloadId, bookId, log } = args;
  safeEmit(broadcaster, 'download_status_change', { download_id: downloadId, book_id: bookId, old_status: 'importing', new_status: 'imported' }, log);
  safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing', new_status: 'imported' }, log);
}

export interface NotifyImportCompleteArgs {
  notifierService: NotifierService | undefined;
  bookTitle: string;
  authorName: string | null | undefined;
  targetPath: string;
  fileCount: number;
  log: FastifyBaseLogger;
}

export function notifyImportComplete(args: NotifyImportCompleteArgs): void {
  const { notifierService, bookTitle, authorName, targetPath, fileCount, log } = args;
  if (!notifierService) return;
  fireAndForget(
    notifierService.notify('on_import', {
      event: 'on_import',
      book: { title: bookTitle, ...(authorName != null && { author: authorName }) },
      import: { libraryPath: targetPath, fileCount },
    }),
    log,
    'Failed to send import notification',
  );
}

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

export function recordImportEvent(args: RecordImportEventArgs): void {
  const { eventHistory, bookId, bookTitle, authorName, downloadId, targetPath, fileCount, totalSize, log } = args;
  if (!eventHistory) return;
  eventHistory.create({
    bookId,
    bookTitle,
    authorName: authorName ?? undefined,
    downloadId,
    eventType: 'imported',
    source: 'auto',
    reason: { targetPath, fileCount, totalSize },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record import event'));
}

export interface EmitImportFailureArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  revertedBookStatus: BookStatus;
  log: FastifyBaseLogger;
}

// Keep failure emits independent so one cannot suppress the other.
export function emitImportFailure(args: EmitImportFailureArgs): void {
  const { broadcaster, downloadId, bookId, revertedBookStatus, log } = args;
  safeEmit(broadcaster, 'download_status_change', { download_id: downloadId, book_id: bookId, old_status: 'importing', new_status: 'failed' }, log);
  safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing', new_status: revertedBookStatus }, log);
}

export interface NotifyImportFailureArgs {
  notifierService: NotifierService | undefined;
  downloadTitle: string;
  error: unknown;
  log: FastifyBaseLogger;
}

export function notifyImportFailure(args: NotifyImportFailureArgs): void {
  const { notifierService, downloadTitle, error, log } = args;
  if (!notifierService) return;
  fireAndForget(
    notifierService.notify('on_failure', {
      event: 'on_failure',
      book: { title: downloadTitle },
      error: { message: getErrorMessage(error), stage: 'import' },
    }),
    log,
    'Failed to send failure notification',
  );
}

export interface RecordImportFailedEventArgs {
  eventHistory: EventHistoryService | undefined;
  bookId: number | null;
  bookTitle: string;
  authorName: string | null | undefined;
  narratorName?: string | null;
  downloadId: number | null;
  source: 'manual' | 'auto';
  error: unknown;
  log: FastifyBaseLogger;
}

export function recordImportFailedEvent(args: RecordImportFailedEventArgs): void {
  const { eventHistory, bookId, bookTitle, authorName, narratorName, downloadId, source, error, log } = args;
  if (!eventHistory) return;
  eventHistory.create({
    bookId,
    bookTitle,
    authorName: authorName ?? undefined,
    ...(narratorName !== undefined ? { narratorName } : {}),
    downloadId,
    eventType: 'import_failed',
    source,
    reason: { error: getErrorMessage(error) },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record import_failed event'));
}
