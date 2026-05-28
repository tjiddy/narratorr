import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { registerRequestTraceLogging } from './request-trace-logging.js';

/**
 * Proves the PRODUCTION wiring: the test imports the same registration export
 * `main()` calls (registerRequestTraceLogging) — it does NOT re-declare the hook
 * bodies inline. A request with a sentinel query param must log the pathname but
 * never the query string at trace level.
 */
describe('registerRequestTraceLogging', () => {
  let app: FastifyInstance;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });

    app = Fastify({ logger: { level: 'trace', stream: captureStream }, disableRequestLogging: true });
    registerRequestTraceLogging(app);
    app.get('/api/search', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs the pathname but not the apikey query string for both hooks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?apikey=trace-leak-canary' });
    expect(res.statusCode).toBe(200);

    const output = lines.join('');
    expect(output).not.toContain('trace-leak-canary');
    expect(output).not.toContain('apikey');

    const incoming = lines.find((l) => l.includes('incoming request'));
    const completed = lines.find((l) => l.includes('request completed'));
    expect(incoming).toBeDefined();
    expect(completed).toBeDefined();

    // Both events carry the sanitized pathname and method, no query string.
    expect(JSON.parse(incoming!)).toMatchObject({ url: '/api/search', method: 'GET' });
    expect(JSON.parse(completed!)).toMatchObject({ url: '/api/search', method: 'GET' });
  });

  it('still logs pathname and method for a request with no query string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(200);

    const incoming = lines.find((l) => l.includes('incoming request'));
    expect(incoming).toBeDefined();
    expect(JSON.parse(incoming!)).toMatchObject({ url: '/api/search', method: 'GET' });
  });
});
