import type { NotificationEvent, EventPayload } from '@shared/notification-events.js';
import type { FailureDescriptor } from '../utils/failure-classification.js';

// Compatibility export for existing core consumers.
export type { NotificationEvent, EventPayload, FailureDescriptor };
export { formatEventMessage } from '@shared/notification-events.js';

export interface NotifierResult {
  success: boolean;
  message?: string;
  /**
   * Structural identity of the failure, for the shared terminal/transient classifier.
   * Absent on success, and legitimately empty when the transport surfaced no code —
   * the classifier reads an absent code as transient, never as terminal (#2312).
   */
  failure?: FailureDescriptor;
}

export interface NotifierAdapter {
  readonly type: string;
  send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult>;
  test(): Promise<NotifierResult>;
}
