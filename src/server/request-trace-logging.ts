import type { FastifyInstance } from 'fastify';
import { sanitizeLogUrl } from './utils/sanitize-log-url.js';

/** Register trace hooks that strip query strings before logging authentication parameters. */
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
