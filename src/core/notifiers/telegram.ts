import type { NotifierAdapter, NotifierResult, NotificationEvent, EventPayload } from './types.js';
import { describeTransportError } from '../utils/failure-classification.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '@shared/notification-events.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Escape HTML entities in user-supplied text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtmlMessage(event: NotificationEvent, payload: EventPayload): string {
  const title = `<b>${EVENT_TITLES[event]}</b>`;
  const message = escapeHtml(formatEventMessage(event, payload));
  return `${title}\n${message}`;
}

export class TelegramNotifier implements NotifierAdapter {
  readonly type = 'telegram';

  constructor(private config: TelegramConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const body = {
      chat_id: this.config.chatId,
      text: buildHtmlMessage(event, payload),
      parse_mode: 'HTML',
    };

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, NOTIFIER_TIMEOUT_MS);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}`, failure: { httpStatus: response.status } };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error), failure: describeTransportError(error) };
    }
  }

  async test(): Promise<NotifierResult> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
