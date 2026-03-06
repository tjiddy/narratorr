export type NotificationEvent = 'on_grab' | 'on_download_complete' | 'on_import' | 'on_failure' | 'on_upgrade' | 'on_health_issue';

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

/** Format a human-readable message from an event payload. */
// eslint-disable-next-line complexity -- one case per event type for clarity
export function formatEventMessage(event: NotificationEvent, payload: EventPayload): string {
  const bookInfo = payload.book ? `${payload.book.title}${payload.book.author ? ` by ${payload.book.author}` : ''}` : '';

  switch (event) {
    case 'on_grab':
      return bookInfo ? `Grabbed: ${bookInfo}` : 'Release grabbed';
    case 'on_download_complete':
      return bookInfo ? `Download complete: ${bookInfo}` : 'Download complete';
    case 'on_import':
      return bookInfo ? `Imported: ${bookInfo}` : 'Import complete';
    case 'on_failure':
      return payload.error ? `Failure: ${payload.error.message}${payload.error.stage ? ` (${payload.error.stage})` : ''}` : 'Failure occurred';
    case 'on_upgrade': {
      const u = payload.upgrade;
      if (!u) return bookInfo ? `Upgraded: ${bookInfo}` : 'Quality upgrade';
      const prev = `${u.previousMbPerHour.toFixed(1)} MB/hr${u.previousCodec ? ` (${u.previousCodec.toUpperCase()})` : ''}`;
      const next = `${u.newMbPerHour.toFixed(1)} MB/hr${u.newCodec ? ` (${u.newCodec.toUpperCase()})` : ''}`;
      return `${bookInfo || 'Book'} upgraded: ${prev} → ${next}`;
    }
    case 'on_health_issue': {
      const h = payload.health;
      if (!h) return 'Health issue detected';
      return `Health issue: ${h.checkName} changed from ${h.previousState} → ${h.currentState}${h.message ? `: ${h.message}` : ''}`;
    }
  }
}

export interface NotifierAdapter {
  readonly type: string;
  send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }>;
  test(): Promise<{ success: boolean; message?: string }>;
}
