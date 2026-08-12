import type { FastifyBaseLogger } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '@shared/schemas/sse-events.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { serializeError } from './serialize-error.js';


// SSE failures are infrastructure noise and must never disturb the caller.
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
