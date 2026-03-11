import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import authPlugin from './auth.js';
import type { AuthService } from '../services/auth.service.js';

// Mock config to control authBypass per test
vi.mock('../config.js', () => ({
  config: {
    authBypass: false,
    isDev: true,
  },
}));

import { config } from '../config.js';

function createMockAuthService(overrides: Partial<Record<keyof AuthService, unknown>> = {}): AuthService {
  return {
    validateApiKey: vi.fn().mockResolvedValue(false),
    getStatus: vi.fn().mockResolvedValue({ mode: 'none', hasUser: false, localBypass: false }),
    hasUser: vi.fn().mockResolvedValue(false),
    verifyCredentials: vi.fn().mockResolvedValue(null),
    getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
    verifySessionCookie: vi.fn().mockReturnValue(null),
    createSessionCookie: vi.fn().mockReturnValue('new-cookie'),
    ...overrides,
  } as unknown as AuthService;
}

async function createApp(authService: AuthService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(authPlugin, { authService });

  // Test routes behind auth
  app.get('/api/test', async () => ({ ok: true }));
  app.put('/api/system/update/dismiss', async () => ({ ok: true }));

  // Non-API route (should not be intercepted)
  app.get('/healthcheck', async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('auth middleware', () => {
  describe('public routes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('public whitelist routes pass without any auth', async () => {
      // Register the public routes so they exist
      for (const url of ['/api/auth/status', '/api/health', '/api/system/status']) {
        const res = await app.inject({ method: 'GET', url });
        // These routes don't exist on our test app, so they'll 404 — but NOT 401
        expect(res.statusCode, `${url} should not be 401`).not.toBe(401);
      }
      // POST /api/auth/login
      const res = await app.inject({ method: 'POST', url: '/api/auth/login' });
      expect(res.statusCode).not.toBe(401);
    });

    it('health/task/info routes are NOT public — return 401 without auth', async () => {
      const protectedRoutes = [
        { method: 'GET' as const, url: '/api/system/health/status' },
        { method: 'GET' as const, url: '/api/system/health/summary' },
        { method: 'POST' as const, url: '/api/system/health/run' },
        { method: 'GET' as const, url: '/api/system/tasks' },
        { method: 'POST' as const, url: '/api/system/tasks/monitor/run' },
        { method: 'GET' as const, url: '/api/system/info' },
      ];
      for (const { method, url } of protectedRoutes) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url} should be 401`).toBe(401);
      }
    });

    it('non-API routes (no /api/ prefix) are never intercepted by auth middleware', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthcheck' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('API key auth', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('X-Api-Key header with valid key passes in all modes (none/basic/forms)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { 'x-api-key': 'valid-key' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('?apikey= query param with valid key passes in all modes', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/test?apikey=valid-key',
      });
      expect(res.statusCode).toBe(200);
    });

    it('array-valued ?apikey query param does not pass garbage to validateApiKey', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      // Fastify parses ?apikey=a&apikey=b as an array — our narrowing should handle it
      const res = await app.inject({
        method: 'GET',
        url: '/api/test?apikey=a&apikey=b',
      });
      // Should fall through to session auth (returns 401 since no session)
      expect(res.statusCode).toBe(401);
      // validateApiKey should NOT have been called with an array
      const calls = (authService.validateApiKey as ReturnType<typeof vi.fn>).mock.calls;
      if (calls.length > 0) {
        expect(typeof calls[0][0]).toBe('string');
      }
    });

    it('invalid API key returns 401', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { 'x-api-key': 'bad-key' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });
  });

  describe('mode: none', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'none', hasUser: false, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('all /api/* requests pass without credentials', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.statusCode).toBe(200);
    });

    it('PUT /api/system/update/dismiss passes without credentials in mode: none', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/system/update/dismiss', payload: { version: '1.0.0' } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('mode: basic', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'basic', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('valid Authorization: Basic header passes', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });
      const encoded = Buffer.from('admin:password123').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('missing header returns 401 with WWW-Authenticate: Basic realm="Narratorr"', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="Narratorr"');
    });

    it('invalid credentials return 401', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const encoded = Buffer.from('admin:wrong').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="Narratorr"');
    });

    it('PUT /api/system/update/dismiss returns 401 without credentials in mode: basic', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/system/update/dismiss', payload: { version: '1.0.0' } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('mode: forms', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('valid session cookie passes', async () => {
      (authService.verifySessionCookie as ReturnType<typeof vi.fn>).mockReturnValue({
        payload: { username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 1000000 },
        shouldRenew: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        cookies: { narratorr_session: 'valid-cookie-value' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('missing cookie returns 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.statusCode).toBe(401);
    });

    it('expired cookie returns 401', async () => {
      (authService.verifySessionCookie as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        cookies: { narratorr_session: 'expired-cookie' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('PUT /api/system/update/dismiss returns 401 without session in mode: forms', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/system/update/dismiss', payload: { version: '1.0.0' } });
      expect(res.statusCode).toBe(401);
    });

    it('cookie >50% TTL triggers re-set (sliding expiry)', async () => {
      (authService.verifySessionCookie as ReturnType<typeof vi.fn>).mockReturnValue({
        payload: { username: 'admin', issuedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
        shouldRenew: true,
      });
      (authService.createSessionCookie as ReturnType<typeof vi.fn>).mockReturnValue('renewed-cookie-value');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        cookies: { narratorr_session: 'old-cookie' },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(String(setCookie)).toContain('narratorr_session=renewed-cookie-value');
    });
  });

  describe('AUTH_BYPASS', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
      (config as { authBypass: boolean }).authBypass = false;
    });

    it('AUTH_BYPASS=true overrides any mode to behave as "none"', async () => {
      (config as { authBypass: boolean }).authBypass = true;

      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);

      const res = await app.inject({ method: 'GET', url: '/api/test' });
      expect(res.statusCode).toBe(200);
      // getStatus should NOT have been called (bypass happens before mode check)
      expect(authService.getStatus).not.toHaveBeenCalled();
    });
  });

  describe('local bypass', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: true }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('enabled: request from 192.168.x.x passes in forms mode', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        remoteAddress: '192.168.1.100',
      });
      expect(res.statusCode).toBe(200);
    });

    it('enabled: request from 10.x.x.x passes in forms mode', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        remoteAddress: '10.0.0.5',
      });
      expect(res.statusCode).toBe(200);
    });

    it('enabled: request from public IP still requires auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        remoteAddress: '8.8.8.8',
      });
      expect(res.statusCode).toBe(401);
    });

    it('disabled: request from private IP still requires auth', async () => {
      const authSvc = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      const testApp = await createApp(authSvc);

      const res = await testApp.inject({
        method: 'GET',
        url: '/api/test',
        remoteAddress: '192.168.1.100',
      });
      expect(res.statusCode).toBe(401);

      await testApp.close();
    });
  });

  describe('URL_BASE-aware path checks', () => {
    const urlBase = '/narratorr';

    async function createUrlBaseApp(
      authService: AuthService,
      extraRoutes?: (app: FastifyInstance) => void,
    ): Promise<FastifyInstance> {
      const app = Fastify({ logger: false });
      await app.register(cookie);
      await app.register(authPlugin, { authService, urlBase });

      // Test route behind auth (under urlBase prefix)
      app.get(`${urlBase}/api/test`, async () => ({ ok: true }));

      // Non-API route under urlBase
      app.get(`${urlBase}/books/123`, async () => ({ page: true }));

      // Route outside urlBase scope
      app.get('/api/other', async () => ({ outside: true }));

      extraRoutes?.(app);

      await app.ready();
      return app;
    }

    it('intercepts {urlBase}/api/protected when URL_BASE is set', async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      const app = await createUrlBaseApp(authService);
      const res = await app.inject({ method: 'GET', url: '/narratorr/api/test' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('skips non-API routes under URL_BASE', async () => {
      const authService = createMockAuthService();
      const app = await createUrlBaseApp(authService);
      const res = await app.inject({ method: 'GET', url: '/narratorr/books/123' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('recognizes PUBLIC_ROUTES with URL_BASE prefix', async () => {
      const authService = createMockAuthService();
      const app = await createUrlBaseApp(authService, (a) => {
        a.get('/narratorr/api/health', async () => ({ status: 'ok' }));
      });

      const res = await app.inject({ method: 'GET', url: '/narratorr/api/health' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('recognizes PUBLIC_ROUTES with query strings under URL_BASE', async () => {
      const authService = createMockAuthService();
      const app = await createUrlBaseApp(authService, (a) => {
        a.get('/narratorr/api/auth/status', async () => ({ mode: 'none' }));
      });

      const res = await app.inject({ method: 'GET', url: '/narratorr/api/auth/status?foo=bar' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('does not intercept /api/ routes outside URL_BASE scope', async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      const app = await createUrlBaseApp(authService);

      // /api/other is outside the /narratorr prefix, so auth hook should not intercept it
      const res = await app.inject({ method: 'GET', url: '/api/other' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
