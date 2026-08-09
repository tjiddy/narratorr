import type { NotificationEvent, EventPayload } from '@shared/notification-events.js';

// Compatibility export for existing core consumers.
export type { NotificationEvent, EventPayload };
export { formatEventMessage } from '@shared/notification-events.js';

export interface NotifierAdapter {
  readonly type: string;
  send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }>;
  test(): Promise<{ success: boolean; message?: string }>;
}
