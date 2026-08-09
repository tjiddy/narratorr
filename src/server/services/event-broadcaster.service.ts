import type { FastifyBaseLogger } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '@shared/schemas/sse-events.js';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_FRAME } from '../utils/sse-stream.js';

// Compatibility re-export; the implementation source is utils/sse-stream.ts.
export { HEARTBEAT_INTERVAL_MS };

export interface SSEClient {
  id: string;
  reply: FastifyReply;
  connectedAt: number;
}

// SSE auth is connect-time only; bound lifetime across logout, password change, and secret rotation.
export const MAX_STREAM_AGE_MS = 45 * 60 * 1_000;

function frameEvent<T extends SSEEventType>(type: T, data: SSEEventPayloads[T]): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class EventBroadcasterService {
  private clients = new Set<SSEClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Reject reconnects between stop() and app.close() or a new hijacked reply blocks shutdown.
  private stopping = false;

  constructor(private log: FastifyBaseLogger) {}

  addClient(client: SSEClient): void {
    if (this.stopping) {
      this.endAndPrune([client], 'shutdown-late');
      return;
    }
    this.clients.add(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client connected');
    this.startHeartbeat();
  }

  removeClient(client: SSEClient): void {
    this.clients.delete(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client disconnected');
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  emit<T extends SSEEventType>(type: T, data: SSEEventPayloads[T]): void {
    if (this.clients.size === 0) return;
    this.writeToAll(frameEvent(type, data));
  }

  // Refuse unregistered clients because shutdown may already have ended their reply.
  emitTo<T extends SSEEventType>(client: SSEClient, type: T, data: SSEEventPayloads[T]): void {
    if (!this.clients.has(client)) return;
    try {
      client.reply.raw.write(frameEvent(type, data));
    } catch {
      this.pruneAfterWriteFailure(client);
    }
  }

  // End in-flight SSE replies and latch stopping so reconnects cannot repopulate the set.
  stop(): void {
    this.stopping = true;
    this.stopHeartbeat();
    this.endAndPrune([...this.clients], 'shutdown');
  }

  // unref prevents the heartbeat from pinning shutdown.
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
    // Sweep before writing; timer-callback failures must remain contained.
    this.sweepStaleClients(Date.now());
    this.writeToAll(SSE_HEARTBEAT_FRAME);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private sweepStaleClients(now: number): void {
    const stale = [...this.clients].filter((c) => now - c.connectedAt > MAX_STREAM_AGE_MS);
    if (stale.length === 0) return;
    this.endAndPrune(stale, 'max-age');
  }

  // End failures never abort the batch; every client is pruned regardless.
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
      this.pruneAfterWriteFailure(dead);
    }
  }

  private pruneAfterWriteFailure(client: SSEClient): void {
    this.clients.delete(client);
    this.log.warn({ clientId: client.id }, 'SSE client removed after write failure');
  }
}
