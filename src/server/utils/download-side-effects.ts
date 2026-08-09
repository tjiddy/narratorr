import type { FastifyBaseLogger } from 'fastify';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { EventHistoryService, CreateEventInput } from '../services/event-history.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { fireAndForget } from './fire-and-forget.js';
import { safeEmit } from './safe-emit.js';
import { serializeError } from './serialize-error.js';


export interface EmitGrabStartedArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  bookTitle: string;
  releaseTitle: string;
  log: FastifyBaseLogger;
}

export function emitGrabStarted(args: EmitGrabStartedArgs): void {
  const { broadcaster, downloadId, bookId, bookTitle, releaseTitle, log } = args;
  safeEmit(broadcaster, 'grab_started', {
    download_id: downloadId, book_id: bookId, book_title: bookTitle, release_title: releaseTitle,
  }, log);
}

export interface EmitBookStatusChangeOnGrabArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  isHandoff: boolean;
  /** The captured pre-grab lifecycle; legacy rows fall back to wanted. */
  oldStatus: BookStatus | null;
  log: FastifyBaseLogger;
}

export function emitBookStatusChangeOnGrab(args: EmitBookStatusChangeOnGrabArgs): void {
  const { broadcaster, bookId, isHandoff, oldStatus, log } = args;
  const newStatus = isHandoff ? 'missing' : 'downloading';
  safeEmit(broadcaster, 'book_status_change', {
    book_id: bookId, old_status: oldStatus ?? 'wanted', new_status: newStatus,
  }, log);
}

export interface EmitDownloadProgressArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  progress: number;
  /** Bytes/sec; omission emits null while zero remains a stalled rate. */
  speed?: number | null;
  log: FastifyBaseLogger;
}

export function emitDownloadProgress(args: EmitDownloadProgressArgs): void {
  const { broadcaster, downloadId, bookId, progress, speed, log } = args;
  safeEmit(broadcaster, 'download_progress', {
    download_id: downloadId, book_id: bookId, percentage: progress, speed: speed ?? null, eta: null,
  }, log);
}

export interface EmitDownloadStatusChangeArgs {
  broadcaster: EventBroadcasterService | undefined;
  downloadId: number;
  bookId: number;
  oldStatus: DownloadStatus;
  newStatus: DownloadStatus;
  log: FastifyBaseLogger;
}

export function emitDownloadStatusChange(args: EmitDownloadStatusChangeArgs): void {
  const { broadcaster, downloadId, bookId, oldStatus, newStatus, log } = args;
  safeEmit(broadcaster, 'download_status_change', {
    download_id: downloadId, book_id: bookId, old_status: oldStatus, new_status: newStatus,
  }, log);
}

export interface EmitBookStatusChangeArgs {
  broadcaster: EventBroadcasterService | undefined;
  bookId: number;
  oldStatus: BookStatus;
  newStatus: BookStatus;
  log: FastifyBaseLogger;
}

export function emitBookStatusChange(args: EmitBookStatusChangeArgs): void {
  const { broadcaster, bookId, oldStatus, newStatus, log } = args;
  safeEmit(broadcaster, 'book_status_change', {
    book_id: bookId, old_status: oldStatus, new_status: newStatus,
  }, log);
}

export interface NotifyGrabArgs {
  notifierService: NotifierService | undefined;
  title: string;
  size: number | undefined;
  log: FastifyBaseLogger;
}

export function notifyGrab(args: NotifyGrabArgs): void {
  const { notifierService, title, size, log } = args;
  if (!notifierService) return;
  fireAndForget(
    notifierService.notify('on_grab', {
      event: 'on_grab',
      book: { title },
      release: { title, ...(size !== undefined && { size }) },
    }),
    log,
    'Failed to send grab notification',
  );
}

export interface RecordGrabbedEventArgs {
  eventHistory: EventHistoryService | undefined;
  bookId: number | undefined;
  bookTitle: string;
  downloadId: number;
  source: CreateEventInput['source'];
  reason: Record<string, unknown>;
  log: FastifyBaseLogger;
}

export function recordGrabbedEvent(args: RecordGrabbedEventArgs): void {
  const { eventHistory, bookId, bookTitle, downloadId, source, reason, log } = args;
  if (!eventHistory || !bookId) return;
  eventHistory.create({
    bookId, bookTitle, downloadId, eventType: 'grabbed', source, reason,
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record grabbed event'));
}

export interface RecordDownloadCompletedEventArgs {
  eventHistory: EventHistoryService | undefined;
  downloadId: number;
  bookId: number | undefined;
  bookTitle: string;
  log: FastifyBaseLogger;
}

export function recordDownloadCompletedEvent(args: RecordDownloadCompletedEventArgs): void {
  const { eventHistory, downloadId, bookId, bookTitle, log } = args;
  if (!eventHistory || !bookId) return;
  eventHistory.create({
    bookId, bookTitle, downloadId, eventType: 'download_completed', source: 'auto',
    reason: { progress: 1 },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record download_completed event'));
}

export interface RecordDownloadFailedEventArgs {
  eventHistory: EventHistoryService | undefined;
  downloadId: number;
  bookId: number | undefined;
  bookTitle: string;
  errorMessage: string;
  log: FastifyBaseLogger;
}

export function recordDownloadFailedEvent(args: RecordDownloadFailedEventArgs): void {
  const { eventHistory, bookId, bookTitle, downloadId, errorMessage, log } = args;
  if (!eventHistory || !bookId) return;
  eventHistory.create({
    bookId, bookTitle, downloadId, eventType: 'download_failed', source: 'auto',
    reason: { error: errorMessage },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record download_failed event'));
}

export interface RecordGrabFailedEventArgs {
  eventHistory: EventHistoryService;
  book: {
    id: number;
    title: string;
    authors?: Array<{ name: string }> | null;
    narrators?: Array<{ name: string }> | null;
  };
  releaseTitle: string;
  errorMessage: string;
  log: FastifyBaseLogger;
}

export function recordGrabFailedEvent(args: RecordGrabFailedEventArgs): void {
  const { eventHistory, book, releaseTitle, errorMessage, log } = args;
  eventHistory.create({
    bookId: book.id,
    bookTitle: book.title,
    authorName: book.authors?.[0]?.name ?? null,
    narratorName: book.narrators?.[0]?.name ?? null,
    eventType: 'grab_failed',
    source: 'auto',
    reason: { error: errorMessage, release_title: releaseTitle },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record grab_failed event'));
}

export interface RecordSearchRelaxedHeldEventArgs {
  eventHistory: EventHistoryService;
  book: {
    id: number;
    title: string;
    authors?: Array<{ name: string }> | null;
    narrators?: Array<{ name: string }> | null;
  };
  relaxedQuery: string;
  variantTag: string;
  releaseTitle: string;
  attempt?: number;
  log: FastifyBaseLogger;
}

// Centralize the two auto-grab paths' event and log shape; persist because scheduled SSE is missed.
export function recordSearchRelaxedHeldEvent(args: RecordSearchRelaxedHeldEventArgs): void {
  const { eventHistory, book, relaxedQuery, variantTag, releaseTitle, attempt, log } = args;
  log.info({
    bookId: book.id, title: book.title, ...(attempt !== undefined && { attempt }),
    relaxedQuery, variantTag, releaseTitle,
  }, 'Relaxed-query candidates held for review — none carried the canonical title anchors');
  eventHistory.create({
    bookId: book.id,
    bookTitle: book.title,
    authorName: book.authors?.[0]?.name ?? null,
    narratorName: book.narrators?.[0]?.name ?? null,
    eventType: 'search_relaxed_held',
    source: 'auto',
    reason: { relaxed_query: relaxedQuery, variant_tag: variantTag, release_title: releaseTitle },
  }).catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record search_relaxed_held event'));
}
