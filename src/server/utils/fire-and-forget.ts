import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './serialize-error.js';


/**
 * Execute a promise without blocking the caller.
 * Rejections are caught and logged at warn level.
 */
export function fireAndForget(promise: Promise<unknown>, log: FastifyBaseLogger, context: string): void {
  promise.catch((err: unknown) => log.warn({ error: serializeError(err) }, context));
}
