import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { authRoutes } from './auth.js';

const TEST_WINDOW_MS = 200;

// Isolate the app so rate-limit counters cannot leak across suites.
async function createRateLimitTestApp(
  services: Services,
  fastifyOpts: FastifyServerOptions = {},
) {
  const app = Fastify({ logger: false, ...fastifyOpts }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Simulate auth middleware
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { username: 'admin' };
  });

  await authRoutes(app, services.auth as Parameters<typeof authRoutes>[1]);
  await app.ready();
  return app;
}

describe('rate limiting', () => {
  let app: FastifyInstance;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createRateLimitTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/auth/login', () => {
    it('returns 429 after exceeding max requests from same IP', async () => {
      resetMockServices(services);
      const ip = '10.0.0.1';

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(429);
    });

    it('includes retry-after header in 429 response', async () => {
      const ip = '10.0.0.2';

      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: ip,
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('POST /api/auth/setup', () => {
    it('returns 429 after 3 requests from same IP', async () => {
      resetMockServices(services);
      const ip = '10.0.0.10';

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'admin', password: 'password1234' },
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'password1234' },
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(429);
    });
  });

  describe('POST /api/auth/api-key/regenerate', () => {
    it('returns 429 after 5 requests from same IP', async () => {
      resetMockServices(services);
      const ip = '10.0.0.20';

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/api-key/regenerate',
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/api-key/regenerate',
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(429);
    });
  });

  describe('IP isolation', () => {
    it('rate limits are independent per IP address', async () => {
      resetMockServices(services);

      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: '10.0.0.30',
        });
      }

      const limitedRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: '10.0.0.30',
      });
      expect(limitedRes.statusCode).toBe(429);

      const freeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: '10.0.0.31',
      });
      expect(freeRes.statusCode).not.toBe(429);
    });
  });

  describe('trustProxy keying', () => {
    it('with trustProxy configured, different XFF values get independent buckets (no cross-client leak)', async () => {
      const trustProxyServices = createMockServices();
      const trustProxyApp = await createRateLimitTestApp(trustProxyServices, {
        trustProxy: ['10.0.0.0/8'],
      });
      try {
        const socketPeer = '10.0.0.99';

        for (let i = 0; i < 5; i++) {
          await trustProxyApp.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'admin', password: 'wrong' },
            remoteAddress: socketPeer,
            headers: { 'x-forwarded-for': '203.0.113.1' },
          });
        }

        const limitedRes = await trustProxyApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: socketPeer,
          headers: { 'x-forwarded-for': '203.0.113.1' },
        });
        expect(limitedRes.statusCode).toBe(429);

        const freeRes = await trustProxyApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: socketPeer,
          headers: { 'x-forwarded-for': '203.0.113.2' },
        });
        expect(freeRes.statusCode).not.toBe(429);
      } finally {
        await trustProxyApp.close();
      }
    });

    it('without trustProxy (baseline), different XFF values share one bucket per socket peer', async () => {
      const baselineServices = createMockServices();
      const baselineApp = await createRateLimitTestApp(baselineServices);
      try {
        const socketPeer = '10.0.0.98';

        for (let i = 0; i < 5; i++) {
          await baselineApp.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'admin', password: 'wrong' },
            remoteAddress: socketPeer,
            headers: { 'x-forwarded-for': '203.0.113.10' },
          });
        }

        const stillLimitedRes = await baselineApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: socketPeer,
          headers: { 'x-forwarded-for': '203.0.113.11' },
        });
        expect(stillLimitedRes.statusCode).toBe(429);
      } finally {
        await baselineApp.close();
      }
    });
  });

  describe('non-limited endpoints', () => {
    it('GET /api/auth/status is not rate limited', async () => {
      resetMockServices(services);
      const ip = '10.0.0.40';

      for (let i = 0; i < 20; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/auth/status',
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }
    });
  });

  describe('recovery', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('allows requests again after time window expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });

      const recoveryApp = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      recoveryApp.setValidatorCompiler(validatorCompiler);
      recoveryApp.setSerializerCompiler(serializerCompiler);
      await recoveryApp.register(cookie);
      await recoveryApp.register(rateLimit, { global: false });
      recoveryApp.decorateRequest('user', null);
      recoveryApp.addHook('onRequest', async (request) => {
        request.user = { username: 'admin' };
      });

      recoveryApp.post('/api/auth/test-rate-limit', {
        config: { rateLimit: { max: 2, timeWindow: TEST_WINDOW_MS } },
      }, async () => {
        return { success: true };
      });
      await recoveryApp.ready();

      const ip = '10.0.0.50';

      try {
        for (let i = 0; i < 2; i++) {
          await recoveryApp.inject({
            method: 'POST',
            url: '/api/auth/test-rate-limit',
            remoteAddress: ip,
          });
        }

        const limitedRes = await recoveryApp.inject({
          method: 'POST',
          url: '/api/auth/test-rate-limit',
          remoteAddress: ip,
        });
        expect(limitedRes.statusCode).toBe(429);

        await vi.advanceTimersByTimeAsync(TEST_WINDOW_MS + 1);

        const recoveredRes = await recoveryApp.inject({
          method: 'POST',
          url: '/api/auth/test-rate-limit',
          remoteAddress: ip,
        });
        expect(recoveredRes.statusCode).toBe(200);
        expect(recoveredRes.headers['retry-after']).toBeUndefined();
      } finally {
        await recoveryApp.close();
      }
    });
  });
});
