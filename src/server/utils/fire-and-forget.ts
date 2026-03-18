import type { FastifyBaseLogger } from 'fastify';

/**
 * Execute a promise without blocking the caller.
 * Rejections are caught and logged at warn level.
 */
export function fireAndForget(promise: Promise<unknown>, log: FastifyBaseLogger, context: string): void {
  promise.catch((err: unknown) => log.warn(err, context));
}
