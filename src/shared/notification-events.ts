/**
 * Notification event constants — leaf module.
 * INVARIANT: This file must NOT import from src/shared/schemas/ or src/shared/notifier-registry.
 * Both of those modules consume this file downstream.
 */

export const NOTIFICATION_EVENTS = [
  'on_grab',
  'on_download_complete',
  'on_import',
  'on_failure',
  'on_upgrade',
  'on_health_issue',
] as const;

export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];

export const EVENT_LABELS: Record<string, string> = {
  on_grab: 'Grab',
  on_download_complete: 'Download Complete',
  on_import: 'Import',
  on_failure: 'Failure',
  on_upgrade: 'Upgrade',
  on_health_issue: 'Health Issue',
} satisfies Record<NotificationEvent, string>;

/** Descriptive event titles for notification adapters. */
export const EVENT_TITLES: Record<NotificationEvent, string> = {
  on_grab: 'Release Grabbed',
  on_download_complete: 'Download Complete',
  on_import: 'Import Complete',
  on_failure: 'Failure',
  on_upgrade: 'Quality Upgrade',
  on_health_issue: 'Health Issue',
};

export interface EventPayload {
  event: NotificationEvent;
  book?: {
    title: string;
    author?: string;
    coverUrl?: string;
  };
  release?: {
    title: string;
    indexer?: string;
    size?: number;
  };
  download?: {
    path?: string;
    size?: number;
  };
  import?: {
    libraryPath?: string;
    fileCount?: number;
  };
  error?: {
    message: string;
    stage?: string;
  };
  upgrade?: {
    previousMbPerHour: number;
    newMbPerHour: number;
    previousCodec?: string;
    newCodec?: string;
    previousSizeBytes?: number;
    newSizeBytes?: number;
  };
  health?: {
    checkName: string;
    previousState: 'healthy' | 'warning' | 'error';
    currentState: 'healthy' | 'warning' | 'error';
    message?: string;
  };
}

type EventFormatter = (payload: EventPayload, bookInfo: string) => string;

const EVENT_FORMATTERS: Record<NotificationEvent, EventFormatter> = {
  on_grab: (_payload, bookInfo) =>
    bookInfo ? `Grabbed: ${bookInfo}` : 'Release grabbed',
  on_download_complete: (_payload, bookInfo) =>
    bookInfo ? `Download complete: ${bookInfo}` : 'Download complete',
  on_import: (_payload, bookInfo) =>
    bookInfo ? `Imported: ${bookInfo}` : 'Import complete',
  on_failure: (payload) =>
    payload.error
      ? `Failure: ${payload.error.message}${payload.error.stage ? ` (${payload.error.stage})` : ''}`
      : 'Failure occurred',
  on_upgrade: (payload, bookInfo) => {
    const u = payload.upgrade;
    if (!u) return bookInfo ? `Upgraded: ${bookInfo}` : 'Quality upgrade';
    const prev = `${u.previousMbPerHour.toFixed(1)} MB/hr${u.previousCodec ? ` (${u.previousCodec.toUpperCase()})` : ''}`;
    const next = `${u.newMbPerHour.toFixed(1)} MB/hr${u.newCodec ? ` (${u.newCodec.toUpperCase()})` : ''}`;
    return `${bookInfo || 'Book'} upgraded: ${prev} → ${next}`;
  },
  on_health_issue: (payload) => {
    const h = payload.health;
    if (!h) return 'Health issue detected';
    return `Health issue: ${h.checkName} changed from ${h.previousState} → ${h.currentState}${h.message ? `: ${h.message}` : ''}`;
  },
};

/** Format a human-readable message from an event payload. */
export function formatEventMessage(event: NotificationEvent, payload: EventPayload): string {
  const bookInfo = payload.book
    ? `${payload.book.title}${payload.book.author ? ` by ${payload.book.author}` : ''}`
    : '';

  const formatter = EVENT_FORMATTERS[event];
  return formatter(payload, bookInfo);
}
