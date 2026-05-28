import type { FastifyInstance } from 'fastify';
import { sanitizeLogUrl } from './utils/sanitize-log-url.js';

/**
 * Registers trace-level request/response logging hooks.
 *
 * Lives in this side-effect-free module (not index.ts, which boots the server
 * at import) so production wiring and tests consume the exact same registration
 * path — a test that re-declares the hook bodies would not prove the production
 * wiring was fixed.
 *
 * `request.url` is a relative path (e.g. '/api/search?apikey=secret') and is run
 * through sanitizeLogUrl to strip the query string — the '?apikey=' query param
 * is supported for auth (SECURITY.md) and must never reach the logs (CLAUDE.md
 * §Logging). `request.id` and `request.method` are safe to log unchanged.
 */
export function registerRequestTraceLogging(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    request.log.trace(
      { url: sanitizeLogUrl(request.url), method: request.method, reqId: request.id },
      'incoming request',
    );
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    request.log.trace(
      {
        url: sanitizeLogUrl(request.url),
        method: request.method,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
    done();
  });
}
