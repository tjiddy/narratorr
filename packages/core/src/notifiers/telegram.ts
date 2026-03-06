import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Escape HTML entities in user-supplied text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const EVENT_TITLES: Record<NotificationEvent, string> = {
  on_grab: 'Release Grabbed',
  on_download_complete: 'Download Complete',
  on_import: 'Import Complete',
  on_failure: 'Failure',
  on_upgrade: 'Quality Upgrade',
  on_health_issue: 'Health Issue',
};

function buildHtmlMessage(event: NotificationEvent, payload: EventPayload): string {
  const title = `<b>${EVENT_TITLES[event]}</b>`;
  const message = escapeHtml(formatEventMessage(event, payload));
  return `${title}\n${message}`;
}

export class TelegramNotifier implements NotifierAdapter {
  readonly type = 'telegram';

  constructor(private config: TelegramConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const body = {
      chat_id: this.config.chatId,
      text: buildHtmlMessage(event, payload),
      parse_mode: 'HTML',
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
