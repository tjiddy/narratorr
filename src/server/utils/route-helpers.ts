import type { FastifyReply } from 'fastify';

/** Send a 500 Internal Server Error response. */
export function sendInternalError(reply: FastifyReply, message = 'Internal server error'): void {
  reply.status(500).send({ error: message });
}
