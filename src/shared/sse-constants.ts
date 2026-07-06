/**
 * Shared SSE cadence + liveness constants (#1798). Single source of truth for the
 * heartbeat interval so the server broadcaster cadence and the client liveness
 * watchdog derive from ONE definition and cannot drift (DRY-1). This lives in
 * `src/shared/` — not `src/server/utils/sse-stream.ts` — because the client cannot
 * import from `src/server/**` (eslint layer guard, `eslint.config.js`). The server
 * wire helper re-exports {@link HEARTBEAT_INTERVAL_MS} so its existing consumers
 * (`event-broadcaster.service.ts`, `routes/search-stream.ts`, and their tests) are
 * unaffected.
 */

/**
 * Heartbeat cadence (#1776). Idle reverse proxies commonly cut a connection with
 * no traffic after ~60s; a sub-minute frame keeps the stream warm between real
 * events. The client watchdog derives its silence threshold from this value.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Named SSE event the server emits on the heartbeat cadence (#1798). Unlike the
 * legacy `:hb` comment frame — which the EventSource spec makes invisible to the
 * browser — a named event is observable by the client, so the liveness watchdog
 * can treat its arrival as proof the stream is still delivering frames. A single
 * named frame is shared by both SSE surfaces (broadcaster + per-request search
 * stream); search-stream has no `hb` listener, and EventSource silently ignores a
 * named event with no matching listener, so promoting the shared frame is harmless
 * there.
 */
export const SSE_HEARTBEAT_EVENT = 'hb';
