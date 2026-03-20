import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { buildHelmetOptions } from './helmet-options.js';
import cspNonceStripPlugin from './csp-nonce-strip.js';

async function createApp(isDev: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(helmet, buildHelmetOptions(isDev));
  await app.register(cspNonceStripPlugin);
  app.get('/test', async (_request, reply) => {
    const nonce = reply.cspNonce?.script;
    return { ok: true, nonce };
  });
  await app.ready();
  return app;
}

describe('cspNonceStripPlugin', () => {
  describe('production mode — style-src nonce stripping', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('style-src directive in sent CSP header contains unsafe-inline but no nonce token', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      const csp = res.headers['content-security-policy'] as string;
      const styleSegment = csp.split(';').find((s) => s.trim().startsWith('style-src'));
      expect(styleSegment).toMatch(/'unsafe-inline'/);
      expect(styleSegment).not.toMatch(/'nonce-/);
    });

    it('script-src directive in sent CSP header retains the per-request nonce token', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      const csp = res.headers['content-security-policy'] as string;
      const scriptSegment = csp.split(';').find((s) => s.trim().startsWith('script-src'));
      expect(scriptSegment).toMatch(/'nonce-[a-f0-9]+'/);
    });

    it('only the nonce token inside style-src is removed — all other directives unchanged', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      const csp = res.headers['content-security-policy'] as string;
      // All other directives must be intact
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self'");
      // style-src present but without nonce
      expect(csp).toContain("https://fonts.googleapis.com");
      // script-src nonce still present
      const scriptSegment = csp.split(';').find((s) => s.trim().startsWith('script-src'));
      expect(scriptSegment).toMatch(/'nonce-[a-f0-9]+'/);
    });

    it('reply.cspNonce.script is non-empty and readable in the route handler before onSend fires', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      const body = res.json();
      // Route handler read reply.cspNonce.script before onSend — must be non-empty hex
      expect(body.nonce).toMatch(/^[a-f0-9]{32,}$/);
    });

    it('HTML response still receives inline script nonce after style nonce is stripped from header', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      const body = res.json();
      const csp = res.headers['content-security-policy'] as string;
      // The nonce in the route-handler body must match the script-src nonce in the sent header
      const scriptSegment = csp.split(';').find((s) => s.trim().startsWith('script-src'))!;
      const nonceMatch = scriptSegment.match(/'nonce-([a-f0-9]+)'/);
      expect(nonceMatch).not.toBeNull();
      expect(body.nonce).toBe(nonceMatch![1]);
    });
  });

  describe('dev mode — no-op when CSP header absent', () => {
    it('does not error or crash the response when no content-security-policy header is present', async () => {
      const app = await createApp(true);
      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
      await app.close();
    });
  });
});
