/**
 * Shared SSE wire helpers (#1799). The "long-lived SSE needs heartbeats" decision
 * lives here — a single source for the keepalive frame + cadence consumed by both
 * SSE surfaces: the multi-client event broadcaster (`event-broadcaster.service.ts`)
 * and the per-request search stream (`routes/search-stream.ts`). Keeping the frame
 * literal and interval in one place stops the two surfaces from drifting apart.
 */

/**
 * Heartbeat cadence (#1776). Idle reverse proxies commonly cut a connection with
 * no traffic after ~60s; a sub-minute comment frame keeps the stream warm between
 * real events.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** A `:`-prefixed line is an SSE comment — clients ignore it. Keepalive only. */
export const SSE_HEARTBEAT_FRAME = ':hb\n\n';

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
