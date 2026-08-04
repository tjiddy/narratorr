import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { type EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';

/**
 * The one thing this route needs from `MergeService` (#2129) — narrow by design, so the SSE
 * route couples to the merge *snapshot* rather than to the whole merge surface. Synchronous
 * by contract; see the greeting comment below for why.
 */
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

    // Send initial keepalive comment (no backfill)
    reply.raw.write(':keepalive\n\n');

    const client = { id: randomUUID(), reply, connectedAt: Date.now() };
    broadcaster.addClient(client);

    // Current-state greeting (#2129). This is NOT event backfill — the "no backfill" rule stands
    // for genuine event types; merge activity is state, and a client that connects after the
    // state was announced would otherwise show no chip until the next change (a queued merge
    // announces nothing until it starts, so it stayed invisible indefinitely).
    //
    // It MUST stay on the same synchronous tick as addClient: an await in between would let a
    // merge state change broadcast to the now-registered client first, after which this stale
    // greeting lands last and overwrites the newer state. That is why the snapshot getter takes
    // no await. Sent even when empty, so a client reconnecting across a missed terminal event
    // clears its stale chips.
    broadcaster.emitTo(client, 'merge_state', mergeState.getMergeStateSnapshot());

    request.raw.on('close', () => {
      broadcaster.removeClient(client);
    });

    // Prevent Fastify from auto-ending the response
    reply.hijack();
  });
}
