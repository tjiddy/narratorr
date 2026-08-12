/** Shared heartbeat wire format; cadence lives in shared code for the client watchdog. */
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_EVENT } from '@shared/sse-constants.js';

export { HEARTBEAT_INTERVAL_MS };

/** Named events are browser-visible; SSE comment frames cannot drive liveness detection. */
export const SSE_HEARTBEAT_FRAME = `event: ${SSE_HEARTBEAT_EVENT}\ndata: {}\n\n`;

/** Start an unref'd heartbeat; the callback must contain its own I/O failures. */
export function startHeartbeat(write: () => void): NodeJS.Timeout {
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

/** Null-safe, idempotent heartbeat cleanup. */
export function stopHeartbeat(timer: NodeJS.Timeout | null | undefined): void {
  if (!timer) return;
  clearInterval(timer);
}
