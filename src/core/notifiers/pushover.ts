import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '../../shared/notification-events.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface PushoverConfig {
  token: string;
  user: string;
}

export class PushoverNotifier implements NotifierAdapter {
  readonly type = 'pushover';

  constructor(private config: PushoverConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const body = {
      token: this.config.token,
      user: this.config.user,
      title: EVENT_TITLES[event],
      message: formatEventMessage(event, payload),
    };

    try {
      const response = await fetchWithTimeout('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, NOTIFIER_TIMEOUT_MS);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      return { success: true };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { success: false, message: 'Request timed out' };
      }
      return { success: false, message: getErrorMessage(error) };
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
