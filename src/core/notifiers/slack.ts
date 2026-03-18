import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '../../shared/notification-events.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';

export interface SlackConfig {
  webhookUrl: string;
}

export class SlackNotifier implements NotifierAdapter {
  readonly type = 'slack';

  constructor(private config: SlackConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const body = {
      text: `*${EVENT_TITLES[event]}*\n${formatEventMessage(event, payload)}`,
    };

    try {
      const response = await fetchWithTimeout(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, NOTIFIER_TIMEOUT_MS);

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
