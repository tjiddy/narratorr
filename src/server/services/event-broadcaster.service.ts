import type { FastifyBaseLogger } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { SSEEventType, SSEEventPayloads } from '../../shared/schemas/sse-events.js';

export interface SSEClient {
  id: string;
  reply: FastifyReply;
}

export class EventBroadcasterService {
  private clients = new Set<SSEClient>();

  constructor(private log: FastifyBaseLogger) {}

  /** Add a connected SSE client. */
  addClient(client: SSEClient): void {
    this.clients.add(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client connected');
  }

  /** Remove a disconnected SSE client. */
  removeClient(client: SSEClient): void {
    this.clients.delete(client);
    this.log.debug({ clientId: client.id, total: this.clients.size }, 'SSE client disconnected');
  }

  /** Get current client count. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Broadcast an SSE event to all connected clients. Fire-and-forget. */
  emit<T extends SSEEventType>(type: T, data: SSEEventPayloads[T]): void {
    if (this.clients.size === 0) return;

    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
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
