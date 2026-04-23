import type { FastifyBaseLogger } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '../../shared/schemas/sse-events.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { serializeError } from './serialize-error.js';


/**
 * Fire-and-forget SSE emit with error swallowing.
 * Null/undefined broadcaster is a silent no-op.
 * Errors are caught and logged at debug level (SSE failures are infrastructure noise).
 */
export function safeEmit<T extends SSEEventType>(
  broadcaster: EventBroadcasterService | null | undefined,
  event: T,
  payload: SSEEventPayloads[T],
  log: FastifyBaseLogger,
): void {
  if (!broadcaster) return;
  try {
    broadcaster.emit(event, payload);
  } catch (error: unknown) {
    log.debug({ error: serializeError(error) }, `SSE emit failed for ${event}`);
  }
}
