import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { type EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';

/** Synchronous snapshot dependency; the greeting must not yield between registration and read. */
export interface MergeStateSource {
  getMergeStateSnapshot(): MergeStateSnapshot;
}

export async function eventsRoutes(
  app: FastifyInstance,
  broadcaster: EventBroadcasterService,
  mergeState: MergeStateSource,
): Promise<void> {
  app.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write(':keepalive\n\n');

    const client = { id: randomUUID(), reply, connectedAt: Date.now() };
    broadcaster.addClient(client);

    // Merge activity is current state, not event backfill. Keep registration and snapshot on the
    // same tick so a stale greeting cannot follow a newer broadcast; empty state clears stale UI.
    broadcaster.emitTo(client, 'merge_state', mergeState.getMergeStateSnapshot());

    request.raw.on('close', () => {
      broadcaster.removeClient(client);
    });

    // Keep the SSE response open.
    reply.hijack();
  });
}
