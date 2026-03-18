import type { FastifyBaseLogger } from 'fastify';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { EventHistoryService, CreateEventInput } from '../services/event-history.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';

// ── emitGrabStarted ─────────────────────────────────────────────────────

export interface EmitGrabStartedArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  bookTitle: string;
  releaseTitle: string;
  log: FastifyBaseLogger;
}

/** Emit grab_started SSE event. Fire-and-forget. */
export function emitGrabStarted(args: EmitGrabStartedArgs): void {
  const { broadcaster, downloadId, bookId, bookTitle, releaseTitle, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('grab_started', {
      download_id: downloadId, book_id: bookId, book_title: bookTitle, release_title: releaseTitle,
    });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitBookStatusChangeOnGrab ──────────────────────────────────────────

export interface EmitBookStatusChangeOnGrabArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  isHandoff: boolean;
  log: FastifyBaseLogger;
}

/** Emit book_status_change SSE for a grab (wanted → downloading or missing). */
export function emitBookStatusChangeOnGrab(args: EmitBookStatusChangeOnGrabArgs): void {
  const { broadcaster, bookId, isHandoff, log } = args;
  if (!broadcaster) return;
  try {
    const newStatus = isHandoff ? 'missing' as const : 'downloading' as const;
    broadcaster.emit('book_status_change', {
      book_id: bookId, old_status: 'wanted' as BookStatus, new_status: newStatus as BookStatus,
    });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitDownloadProgress ────────────────────────────────────────────────

export interface EmitDownloadProgressArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  progress: number;
  log: FastifyBaseLogger;
}

/** Emit download_progress SSE. Fire-and-forget. */
export function emitDownloadProgress(args: EmitDownloadProgressArgs): void {
  const { broadcaster, downloadId, bookId, progress, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('download_progress', {
      download_id: downloadId, book_id: bookId, percentage: progress, speed: null, eta: null,
    });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitDownloadStatusChange ────────────────────────────────────────────

export interface EmitDownloadStatusChangeArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  oldStatus: string;
  newStatus: string;
  log: FastifyBaseLogger;
}

/** Emit download_status_change SSE. Fire-and-forget. */
export function emitDownloadStatusChange(args: EmitDownloadStatusChangeArgs): void {
  const { broadcaster, downloadId, bookId, oldStatus, newStatus, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('download_status_change', {
      download_id: downloadId, book_id: bookId, old_status: oldStatus as DownloadStatus, new_status: newStatus as DownloadStatus,
    });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── emitBookStatusChange ────────────────────────────────────────────────

export interface EmitBookStatusChangeArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  oldStatus: string;
  newStatus: string;
  log: FastifyBaseLogger;
}

/** Emit book_status_change SSE. Fire-and-forget. */
export function emitBookStatusChange(args: EmitBookStatusChangeArgs): void {
  const { broadcaster, bookId, oldStatus, newStatus, log } = args;
  if (!broadcaster) return;
  try {
    broadcaster.emit('book_status_change', {
      book_id: bookId, old_status: oldStatus as BookStatus, new_status: newStatus as BookStatus,
    });
  } catch (e) { log.debug(e, 'SSE emit failed'); }
}

// ── notifyGrab ──────────────────────────────────────────────────────────

export interface NotifyGrabArgs {
  notifierService: NotifierService | undefined;
  title: string;
  size: number | undefined;
  log: FastifyBaseLogger;
}

/** Fire-and-forget grab notification. */
export function notifyGrab(args: NotifyGrabArgs): void {
  const { notifierService, title, size, log } = args;
  if (!notifierService) return;
  Promise.resolve(notifierService.notify('on_grab', {
    event: 'on_grab',
    book: { title },
    release: { title, size },
  })).catch((err: unknown) => log.warn(err, 'Failed to send grab notification'));
}

// ── recordGrabbedEvent ──────────────────────────────────────────────────

export interface RecordGrabbedEventArgs {
  eventHistory: EventHistoryService | undefined;
  bookId: number | undefined;
  bookTitle: string;
  downloadId: number;
  source: CreateEventInput['source'];
  reason: Record<string, unknown>;
  log: FastifyBaseLogger;
}

/** Fire-and-forget grabbed event recording. Skips if no eventHistory or bookId. */
export function recordGrabbedEvent(args: RecordGrabbedEventArgs): void {
  const { eventHistory, bookId, bookTitle, downloadId, source, reason, log } = args;
  if (!eventHistory || !bookId) return;
  eventHistory.create({
    bookId, bookTitle, downloadId, eventType: 'grabbed', source, reason,
  }).catch((err: unknown) => log.warn(err, 'Failed to record grabbed event'));
}

// ── recordDownloadCompletedEvent ────────────────────────────────────────

export interface RecordDownloadCompletedEventArgs {
  eventHistory: EventHistoryService | undefined;
  downloadId: number;
  bookId: number | undefined;
  bookTitle: string;
  log: FastifyBaseLogger;
}

/** Fire-and-forget download_completed event recording. */
export function recordDownloadCompletedEvent(args: RecordDownloadCompletedEventArgs): void {
  const { eventHistory, downloadId, bookId, bookTitle, log } = args;
  if (!eventHistory || !bookId) return;
  eventHistory.create({
    bookId, bookTitle, downloadId, eventType: 'download_completed', source: 'auto',
    reason: { progress: 1 },
  }).catch((err: unknown) => log.warn(err, 'Failed to record download_completed event'));
}
