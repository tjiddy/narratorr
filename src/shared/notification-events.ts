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
  'on_health_issue',
  'import_run_finished',
] as const;

export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];

export const EVENT_LABELS: Record<string, string> = {
  on_grab: 'Grab',
  on_download_complete: 'Download Complete',
  on_import: 'Import',
  on_failure: 'Failure',
  on_health_issue: 'Health Issue',
  import_run_finished: 'Import Run Finished',
} satisfies Record<NotificationEvent, string>;

/** Descriptive event titles for notification adapters. */
export const EVENT_TITLES: Record<NotificationEvent, string> = {
  on_grab: 'Release Grabbed',
  on_download_complete: 'Download Complete',
  on_import: 'Import Complete',
  on_failure: 'Failure',
  on_health_issue: 'Health Issue',
  import_run_finished: 'Import Run Finished',
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
  health?: {
    checkName: string;
    previousState: 'healthy' | 'warning' | 'error';
    currentState: 'healthy' | 'warning' | 'error';
    message?: string | undefined;
  };
  /** Terminal outcome of a staged import run (#1894, `import_run_finished`). */
  submission?: {
    source: 'library' | 'manual';
    status: 'complete';
    counts: { accepted: number; held: number; skipped: number; failed: number };
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
  on_failure: (payload, bookInfo) =>
    payload.error
      ? `Failure${bookInfo ? ` — ${bookInfo}` : ''}: ${payload.error.message}${payload.error.stage ? ` (${payload.error.stage})` : ''}`
      : `Failure occurred${bookInfo ? ` — ${bookInfo}` : ''}`,
  on_health_issue: (payload) => {
    const h = payload.health;
    if (!h) return 'Health issue detected';
    return `Health issue: ${h.checkName} changed from ${h.previousState} → ${h.currentState}${h.message ? `: ${h.message}` : ''}`;
  },
  import_run_finished: (payload) => {
    const s = payload.submission;
    if (!s) return 'Import run finished';
    const label = s.source === 'library' ? 'Library' : 'Manual';
    const { accepted, held, skipped, failed } = s.counts;
    // "queued" for accepted — a forced import can still be refused at copy-time.
    return `${label} import finished — ${accepted} queued, ${held} held, ${skipped} skipped, ${failed} failed`;
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
