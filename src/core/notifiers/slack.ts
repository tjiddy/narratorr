import type { NotifierAdapter, NotifierResult, NotificationEvent, EventPayload } from './types.js';
import { describeTransportError } from '../utils/failure-classification.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '@shared/notification-events.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface SlackConfig {
  webhookUrl: string;
}

export class SlackNotifier implements NotifierAdapter {
  readonly type = 'slack';

  constructor(private config: SlackConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult> {
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
