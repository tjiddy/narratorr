import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './serialize-error.js';


export function fireAndForget(promise: Promise<unknown>, log: FastifyBaseLogger, context: string): void {
  promise.catch((err: unknown) => log.warn({ error: serializeError(err) }, context));
}
