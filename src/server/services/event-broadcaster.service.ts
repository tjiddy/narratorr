import type { FastifyBaseLogger } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '../../shared/schemas/sse-events.js';

export interface SSEClient {
  id: string;
  reply: FastifyReply;
}

/**
 * Heartbeat cadence (#1776). Idle reverse proxies commonly cut a connection with
 * no traffic after ~60s; a sub-minute comment frame keeps the stream warm between
 * real events. A `:`-prefixed line is an SSE comment — clients ignore it.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_FRAME = ':hb\n\n';

export class EventBroadcasterService {
  private clients = new Set<SSEClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private log: FastifyBaseLogger) {}

  /** Add a connected SSE client. */
  addClient(client: SSEClient): void {
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

  /** Stop the heartbeat timer. Idempotent; call on shutdown to release the loop. */
  stop(): void {
    this.stopHeartbeat();
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
    this.writeToAll(HEARTBEAT_FRAME);
    if (this.clients.size === 0) this.stopHeartbeat();
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
