import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet, { type FastifyHelmetOptions } from '@fastify/helmet';

const sharedOptions = {
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' as const },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
};

const prodOptions: FastifyHelmetOptions = {
  ...sharedOptions,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
};

const devOptions: FastifyHelmetOptions = {
  ...sharedOptions,
  contentSecurityPolicy: false,
};

async function createApp(options: FastifyHelmetOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(helmet, options);
  app.get('/api/test', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('Security Headers (helmet)', () => {
  describe('production mode', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(prodOptions);
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

    it('includes Strict-Transport-Security header on responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.headers['strict-transport-security']).toContain('max-age=');
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
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self'");
    });
  });

  describe('dev mode', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(devOptions);
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
