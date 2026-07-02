/**
 * Shared SSE wire helpers (#1799). The "long-lived SSE needs heartbeats" decision
 * lives here — a single source for the keepalive frame consumed by both SSE
 * surfaces: the multi-client event broadcaster (`event-broadcaster.service.ts`)
 * and the per-request search stream (`routes/search-stream.ts`). Keeping the frame
 * literal in one place stops the two surfaces from drifting apart.
 *
 * The cadence itself (#1798) now lives in `src/shared/sse-constants.ts` so the
 * client liveness watchdog can derive its silence threshold from the same value
 * without importing across the `src/server/**` layer boundary. It is re-exported
 * below so this module's existing server consumers/tests keep importing it here.
 */
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_EVENT } from '../../shared/sse-constants.js';

export { HEARTBEAT_INTERVAL_MS };

/**
 * The heartbeat wire frame (#1798). Promoted from the legacy `:hb` comment frame
 * to a named `hb` event so the browser can observe it — a `:`-prefixed comment is
 * invisible to EventSource, which left a deaf (half-open) stream undetectable on
 * the client. A single named frame is shared by both SSE surfaces; the search
 * stream registers no `hb` listener and EventSource ignores unmatched named
 * events, so the promotion is harmless there. See {@link SSE_HEARTBEAT_EVENT}.
 */
export const SSE_HEARTBEAT_FRAME = `event: ${SSE_HEARTBEAT_EVENT}\ndata: {}\n\n`;

/**
 * Start a single-timer heartbeat that invokes `write` every
 * `HEARTBEAT_INTERVAL_MS`. The timer is `unref()`'d so a pending tick never pins
 * the event loop past shutdown (mirrors the broadcaster / jobs). The caller owns
 * stopping it via {@link stopHeartbeat}. Note: `write` runs from a `setInterval`
 * callback with no caller on the stack — a throw would crash the process, so the
 * callback MUST guard its own I/O.
 */
export function startHeartbeat(write: () => void): NodeJS.Timeout {
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Stop a heartbeat timer. Null-safe and idempotent: passing `null`/`undefined`
 * is a no-op, and `clearInterval` on an already-cleared timer is harmless — so a
 * `finally` block and a `close` handler can both call it safely.
 */
export function stopHeartbeat(timer: NodeJS.Timeout | null | undefined): void {
  if (!timer) return;
  clearInterval(timer);
}
