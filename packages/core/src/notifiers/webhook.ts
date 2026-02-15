import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';

export interface WebhookConfig {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

/** Replace `{token.path}` placeholders with values from the payload. */
function renderBody(template: string, event: NotificationEvent, payload: EventPayload): string {
  const flat: Record<string, string> = {
    event,
    'book.title': payload.book?.title ?? '',
    'book.author': payload.book?.author ?? '',
    'book.coverUrl': payload.book?.coverUrl ?? '',
    'release.title': payload.release?.title ?? '',
    'release.indexer': payload.release?.indexer ?? '',
    'release.size': payload.release?.size?.toString() ?? '',
    'download.path': payload.download?.path ?? '',
    'download.size': payload.download?.size?.toString() ?? '',
    'import.libraryPath': payload.import?.libraryPath ?? '',
    'import.fileCount': payload.import?.fileCount?.toString() ?? '',
    'error.message': payload.error?.message ?? '',
    'error.stage': payload.error?.stage ?? '',
  };

  return template.replace(/\{(\w+(?:\.\w+)*)\}/g, (match, key: string) => key in flat ? flat[key] : match);
}

export class WebhookNotifier implements NotifierAdapter {
  readonly type = 'webhook';

  constructor(private config: WebhookConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const method = this.config.method || 'POST';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    let body: string;
    if (this.config.bodyTemplate) {
      body = renderBody(this.config.bodyTemplate, event, payload);
    } else {
      body = JSON.stringify(payload);
    }

    const response = await fetch(this.config.url, { method, headers, body });

    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status}: ${response.statusText}` };
    }

    return { success: true };
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
