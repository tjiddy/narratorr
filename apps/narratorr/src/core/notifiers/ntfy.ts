import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';

export interface NtfyConfig {
  topic: string;
  serverUrl?: string;
}

const EVENT_TITLES: Record<NotificationEvent, string> = {
  on_grab: 'Release Grabbed',
  on_download_complete: 'Download Complete',
  on_import: 'Import Complete',
  on_failure: 'Failure',
  on_upgrade: 'Quality Upgrade',
  on_health_issue: 'Health Issue',
};

export class NtfyNotifier implements NotifierAdapter {
  readonly type = 'ntfy';

  constructor(private config: NtfyConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const baseUrl = this.config.serverUrl?.replace(/\/+$/, '') || 'https://ntfy.sh';
    const url = `${baseUrl}/${this.config.topic}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Title: EVENT_TITLES[event],
        },
        body: formatEventMessage(event, payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      return { success: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { success: false, message: 'Request timed out' };
      }
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
