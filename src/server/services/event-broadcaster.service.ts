import type { FastifyBaseLogger } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '../../shared/schemas/sse-events.js';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_FRAME } from '../utils/sse-stream.js';

// Re-exported for existing consumers/tests that import the cadence from the
// broadcaster; the single source of truth now lives in `utils/sse-stream.ts` (#1799).
export { HEARTBEAT_INTERVAL_MS };

export interface SSEClient {
  id: string;
  reply: FastifyReply;
  /** `Date.now()` at registration — drives the max-age sweep (#1796). */
  connectedAt: number;
}

/**
 * Max stream lifetime (#1796). Post-#1787 the client never reopens a healthy
 * stream, so a stream token (5-min TTL, carried as `?token=`) replayed within its
 * window would otherwise yield an event stream that survives token expiry, logout,
 * password change, and secret rotation. Bounding lifetime forces the normal
 * EventSource error → re-mint → reopen → catch-up path at a generous cap — still
 * ~11x fewer reconnects than the old ~4-min re-mint cycle, so #1787's churn-
 * reduction goal is preserved. Live `/api/events` auth stays connect-time-only;
 * this is a lifetime bound, not per-event re-authentication.
 */
export const MAX_STREAM_AGE_MS = 45 * 60 * 1_000;

export class EventBroadcasterService {
  private clients = new Set<SSEClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Latched by stop() so a client that reconnects during the graceful-shutdown
  // drain window (after stop(), before app.close()) is ended on arrival instead
  // of re-registered — otherwise its never-ended hijacked reply re-blocks
  // app.close() and re-introduces the #1796 SIGKILL hang (#1813). Mirrors the
  // `stopping` latch in ConnectorRefreshQueue / ImportQueueWorker.
  private stopping = false;

  constructor(private log: FastifyBaseLogger) {}

  /** Add a connected SSE client. */
  addClient(client: SSEClient): void {
    // Shutdown drain window: reject the late reconnect. End the incoming reply so
    // the browser gets a closed stream and keeps retrying until the NEW process is
    // up (#1787's catch-up covers the gap), and do NOT restart the heartbeat. See
    // the `stopping` latch note above (#1813).
    if (this.stopping) {
      this.endAndPrune([client], 'shutdown-late');
      return;
    }
    this.clients.add(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client connected');
    this.startHeartbeat();
  }

  /** Remove a disconnected SSE client. */
  removeClient(client: SSEClient): void {
    this.clients.delete(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client disconnected');
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /** Get current client count. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Broadcast an SSE event to all connected clients. Fire-and-forget. */
  emit<T extends SSEEventType>(type: T, data: SSEEventPayloads[T]): void {
    if (this.clients.size === 0) return;
    this.writeToAll(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Stop the heartbeat timer and END every connected client reply (#1796).
   * Idempotent. Ending the hijacked replies is what lets graceful shutdown
   * complete: Fastify's default `forceCloseConnections: 'idle'` never reaps a
   * socket with an in-flight response, and a never-ended SSE reply is never idle —
   * so without this, `app.close()` blocks until every tab disconnects and the
   * deploy degrades to the SIGKILL timer. Browsers auto-reconnect to the new
   * process; #1787's catch-up handles the gap.
   *
   * Latches `stopping` so a client that reconnects during the post-stop() drain
   * window is ended on arrival rather than re-registered (#1813) — see
   * `addClient`. Idempotent: re-entry just re-ends an already-empty set.
   */
  stop(): void {
    this.stopping = true;
    this.stopHeartbeat();
    this.endAndPrune([...this.clients], 'shutdown');
  }

  /**
   * Start the periodic heartbeat, lazily on the first client. The timer is
   * `unref()`'d so a pending tick never pins the event loop past shutdown
   * (mirrors ConnectorService / jobs). It self-stops once no clients remain.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendHeartbeat(): void {
    // Sweep before writing so max-age clients are ended (not heartbeated) and the
    // surviving fresh clients still get their frame. Any throw is caught inside
    // sweepStaleClients / endAndPrune — an uncaught throw here has no caller (this
    // runs from the setInterval callback) and would crash the process (#1796).
    this.sweepStaleClients(Date.now());
    this.writeToAll(SSE_HEARTBEAT_FRAME);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /** End and prune every client older than the max-age cap (#1796). */
  private sweepStaleClients(now: number): void {
    const stale = [...this.clients].filter((c) => now - c.connectedAt > MAX_STREAM_AGE_MS);
    if (stale.length === 0) return;
    this.endAndPrune(stale, 'max-age');
  }

  /**
   * End a batch of client replies and remove them from the set. Shared by
   * shutdown teardown and the max-age sweep (#1796) so the two paths cannot
   * diverge. Failure-tolerant, mirroring `writeToAll`'s catch-then-prune: an
   * `end()` that throws (broken pipe) on one client neither aborts the batch nor
   * leaves that client behind — the client is pruned regardless and the loop
   * continues. Safe to call from the heartbeat timer callback: no throw escapes.
   */
  private endAndPrune(clients: Iterable<SSEClient>, reason: string): void {
    for (const client of clients) {
      try {
        client.reply.raw.end();
      } catch {
        // Broken pipe / already-destroyed socket — prune regardless below.
      }
      this.clients.delete(client);
      this.log.debug({ clientId: client.id, reason }, 'SSE client ended');
    }
  }

  /** Write a raw SSE frame to every client, pruning any that fail. */
  private writeToAll(message: string): void {
    const deadClients: SSEClient[] = [];

    for (const client of this.clients) {
      try {
        client.reply.raw.write(message);
      } catch {
        deadClients.push(client);
      }
    }

    for (const dead of deadClients) {
      this.clients.delete(dead);
      this.log.warn({ clientId: dead.id }, 'SSE client removed after write failure');
    }
  }
}
