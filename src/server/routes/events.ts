import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { type EventBroadcasterService } from '../services/event-broadcaster.service.js';

export async function eventsRoutes(
  app: FastifyInstance,
  broadcaster: EventBroadcasterService,
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

    const client = { id: randomUUID(), reply };
    broadcaster.addClient(client);

    request.raw.on('close', () => {
      broadcaster.removeClient(client);
    });

    // Prevent Fastify from auto-ending the response
    reply.hijack();
  });
}
