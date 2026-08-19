import type { NotifierAdapter, NotifierResult, NotificationEvent, EventPayload } from './types.js';
import { describeTransportError } from '../utils/failure-classification.js';
import { formatEventMessage } from './types.js';
import { EVENT_TITLES } from '@shared/notification-events.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface NtfyConfig {
  topic: string;
  serverUrl?: string | undefined;
  accessToken?: string | undefined;
  priority?: string | undefined;
}

export class NtfyNotifier implements NotifierAdapter {
  readonly type = 'ntfy';

  constructor(private config: NtfyConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult> {
    const baseUrl = this.config.serverUrl?.replace(/\/+$/, '') || 'https://ntfy.sh';
    const url = `${baseUrl}/${this.config.topic}`;

    const headers: Record<string, string> = {
      Title: EVENT_TITLES[event],
    };
    if (this.config.accessToken) headers.Authorization = `Bearer ${this.config.accessToken}`;
    if (this.config.priority) headers.Priority = this.config.priority;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: formatEventMessage(event, payload),
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
