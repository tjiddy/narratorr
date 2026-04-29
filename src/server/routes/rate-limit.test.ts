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

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4 },
}));

import { filesystemRoutes } from './filesystem.js';

/** Short time window for fast tests (ms). */
const TEST_WINDOW_MS = 200;

/**
 * Creates a rate-limit test app with a very short time window.
 * Separate from the main auth test app to avoid counter leakage.
 */
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

      // Send max allowed requests (5 for login)
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }

      // 6th request should be rate limited
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

      // Exhaust the limit
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

      // Exhaust limit from IP A
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: '10.0.0.30',
        });
      }

      // IP A should be limited
      const limitedRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: '10.0.0.30',
      });
      expect(limitedRes.statusCode).toBe(429);

      // IP B should still be fine
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

        // Exhaust limit for client A (XFF: 203.0.113.1)
        for (let i = 0; i < 5; i++) {
          await trustProxyApp.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'admin', password: 'wrong' },
            remoteAddress: socketPeer,
            headers: { 'x-forwarded-for': '203.0.113.1' },
          });
        }

        // Client A should be limited
        const limitedRes = await trustProxyApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'wrong' },
          remoteAddress: socketPeer,
          headers: { 'x-forwarded-for': '203.0.113.1' },
        });
        expect(limitedRes.statusCode).toBe(429);

        // Client B (different XFF, same socket peer) should still be free
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

        // Exhaust limit through XFF A
        for (let i = 0; i < 5; i++) {
          await baselineApp.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'admin', password: 'wrong' },
            remoteAddress: socketPeer,
            headers: { 'x-forwarded-for': '203.0.113.10' },
          });
        }

        // Different XFF, same socket peer → still limited (bucket shared)
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

  describe('GET /api/filesystem/browse', () => {
    let fsApp: FastifyInstance;

    beforeAll(async () => {
      const fsApp_ = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      fsApp_.setValidatorCompiler(validatorCompiler);
      fsApp_.setSerializerCompiler(serializerCompiler);
      await fsApp_.register(rateLimit, { global: false });
      await filesystemRoutes(fsApp_);
      await fsApp_.ready();
      fsApp = fsApp_;
    });

    afterAll(async () => {
      await fsApp.close();
    });

    it('allows 60 requests within the window from the same IP', async () => {
      const ip = '10.0.0.60';
      for (let i = 0; i < 60; i++) {
        const res = await fsApp.inject({
          method: 'GET',
          url: '/api/filesystem/browse?path=/tmp',
          remoteAddress: ip,
        });
        expect(res.statusCode).not.toBe(429);
      }
    });

    it('returns 429 on the 61st request from the same IP within the window', async () => {
      const ip = '10.0.0.61';
      for (let i = 0; i < 60; i++) {
        await fsApp.inject({
          method: 'GET',
          url: '/api/filesystem/browse?path=/tmp',
          remoteAddress: ip,
        });
      }
      const res = await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('does not throttle a request from a different IP within the same window', async () => {
      const ipA = '10.0.0.62';
      const ipB = '10.0.0.63';
      for (let i = 0; i < 60; i++) {
        await fsApp.inject({
          method: 'GET',
          url: '/api/filesystem/browse?path=/tmp',
          remoteAddress: ipA,
        });
      }
      // ipA's bucket is full; ipB should still pass.
      const limitedA = await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ipA,
      });
      expect(limitedA.statusCode).toBe(429);

      const freeB = await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ipB,
      });
      expect(freeB.statusCode).not.toBe(429);
    });
  });

  describe('non-limited endpoints', () => {
    it('GET /api/auth/status is not rate limited', async () => {
      resetMockServices(services);
      const ip = '10.0.0.40';

      // Send many requests — should never get 429
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

      // Create a separate app with a very short time window for recovery testing
      const recoveryApp = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      recoveryApp.setValidatorCompiler(validatorCompiler);
      recoveryApp.setSerializerCompiler(serializerCompiler);
      await recoveryApp.register(cookie);
      await recoveryApp.register(rateLimit, { global: false });
      recoveryApp.decorateRequest('user', null);
      recoveryApp.addHook('onRequest', async (request) => {
        request.user = { username: 'admin' };
      });

      // Register a simple test route with a short window
      recoveryApp.post('/api/auth/test-rate-limit', {
        config: { rateLimit: { max: 2, timeWindow: TEST_WINDOW_MS } },
      }, async () => {
        return { success: true };
      });
      await recoveryApp.ready();

      const ip = '10.0.0.50';

      try {
        // Exhaust the limit
        for (let i = 0; i < 2; i++) {
          await recoveryApp.inject({
            method: 'POST',
            url: '/api/auth/test-rate-limit',
            remoteAddress: ip,
          });
        }

        // Should be rate limited
        const limitedRes = await recoveryApp.inject({
          method: 'POST',
          url: '/api/auth/test-rate-limit',
          remoteAddress: ip,
        });
        expect(limitedRes.statusCode).toBe(429);

        // Advance past the rate-limit window using fake timers
        await vi.advanceTimersByTimeAsync(TEST_WINDOW_MS + 1);

        // Should be allowed again
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
