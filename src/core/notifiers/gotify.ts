import type { NotifierAdapter, NotifierResult, NotificationEvent, EventPayload } from './types.js';
import { describeTransportError } from '../utils/failure-classification.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '@shared/notification-events.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface GotifyConfig {
  serverUrl: string;
  token: string;
}

export class GotifyNotifier implements NotifierAdapter {
  readonly type = 'gotify';

  constructor(private config: GotifyConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult> {
    const url = `${this.config.serverUrl.replace(/\/+$/, '')}/message`;
    const body = {
      title: EVENT_TITLES[event],
      message: formatEventMessage(event, payload),
      priority: event === 'on_failure' || event === 'on_health_issue' ? 8 : 5,
    };

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': this.config.token,
        },
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
