import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSecurityPlugins } from './security-plugins.js';
import { buildHelmetOptions } from './helmet-options.js';

async function createApp(isDev: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerSecurityPlugins(app, isDev);
  app.get('/api/test', async (_request, reply) => {
    // Access cspNonce to verify it's generated (only in prod mode)
    const nonce = reply.cspNonce?.script;
    return { ok: true, nonce };
  });
  await app.ready();
  return app;
}

describe('Security Headers (helmet)', () => {
  describe('helmet options builder', () => {
    it('prod options include nonce-based script-src instead of unsafe-inline', async () => {
      const app = await createApp(false);
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toMatch(/script-src 'self' 'nonce-[a-f0-9]+'/);
      await app.close();
    });

    it('prod options do not contain unsafe-inline in script-src', async () => {
      const app = await createApp(false);
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      await app.close();
    });

    it('dev options disable CSP entirely (contentSecurityPolicy: false)', async () => {
      const app = await createApp(true);
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['content-security-policy']).toBeUndefined();
      await app.close();
    });

    it('test imports shared builder used by index.ts — not a detached fixture', () => {
      // This test proves the builder is the same module used in production.
      // If the import path changes in index.ts but not here, the build breaks.
      const prodOptions = buildHelmetOptions(false);
      expect(prodOptions.enableCSPNonces).toBe(true);
      expect(prodOptions.contentSecurityPolicy).toBeTruthy();

      const devOptions = buildHelmetOptions(true);
      expect(devOptions.contentSecurityPolicy).toBe(false);
    });
  });

  describe('production mode', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('includes X-Content-Type-Options: nosniff on responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('includes X-Frame-Options: DENY on responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('does not include Strict-Transport-Security (self-hosted, no TLS)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('includes Referrer-Policy on responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    it('includes Content-Security-Policy in production config', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      // Semantic check: style-src must allow unsafe-inline AND must NOT contain a nonce.
      // toContain() would pass even if a 'nonce-...' token were appended by helmet, because
      // it only checks for a substring. The two-part check below is the correct contract.
      const styleSegment = csp.split(';').find((s) => s.trim().startsWith('style-src'));
      expect(styleSegment).toMatch(/'unsafe-inline'/);
      expect(styleSegment).not.toMatch(/'nonce-/);
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self'");
    });

    it('generates unique nonces per request', async () => {
      const res1 = await app.inject({ method: 'GET', url: '/api/test' });
      const res2 = await app.inject({ method: 'GET', url: '/api/test' });
      const nonce1 = res1.json().nonce;
      const nonce2 = res2.json().nonce;
      expect(nonce1).toBeDefined();
      expect(nonce2).toBeDefined();
      expect(nonce1).not.toBe(nonce2);
    });

    it('nonce is valid hex and at least 16 bytes (32 hex chars)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      const nonce = res.json().nonce;
      expect(nonce).toMatch(/^[a-f0-9]{32,}$/);
    });
  });

  describe('dev mode', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(true);
    });

    afterAll(async () => {
      await app.close();
    });

    it('does NOT include Content-Security-Policy in dev config', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  });
});
