import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import authPlugin from './auth.js';
import type { AuthService } from '../services/auth.service.js';
import { v1ErrorEnvelopeSchema } from '../../shared/schemas/v1/common.js';

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
    verifyStreamToken: vi.fn().mockReturnValue(null),
    createSessionCookie: vi.fn().mockReturnValue('new-cookie'),
    ...overrides,
  } as unknown as AuthService;
}

async function createApp(
  authService: AuthService,
  fastifyOpts: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...fastifyOpts });
  await app.register(cookie);
  await app.register(authPlugin, { authService });

  // Test routes behind auth
  app.get('/api/test', async (request) => ({ ok: true, ip: request.ip }));
  app.put('/api/test-mutation', async () => ({ ok: true }));
  app.post('/api/library/scan-debug', async () => ({ ok: true }));

  // Versioned public-surface routes (#1453) — the only paths the API key still
  // authenticates after de-god-moding.
  app.get('/api/v1/test', async () => ({ ok: true }));
  app.post('/api/v1/test-mutation', async () => ({ ok: true }));
  // Off-by-one guard: starts with `/api/v` but the char after `v` is not a digit,
  // so it must NOT be classified as in-scope.
  app.get('/api/version-history', async () => ({ ok: true }));

  // Prowlarr/Readarr compat-shim routes (#1472): they live under `/api/v1/*` but
  // are the documented contract *exception* — auth failures here keep the legacy
  // bare-string body, NOT the native v1 envelope.
  app.get('/api/v1/system/status', async () => ({ ok: true }));
  app.get('/api/v1/indexer', async () => ({ ok: true }));

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
        { method: 'POST' as const, url: '/api/library/scan-debug' },
        { method: 'POST' as const, url: '/api/settings/metadata/hardcover/test' },
      ];
      for (const { method, url } of protectedRoutes) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url} should be 401`).toBe(401);
      }
    });

    it('new authenticated admin endpoints (#742) are NOT public — return 401 without auth', async () => {
      // /api/auth/admin-status was carved out of the public auth status payload
      // so admin/deployment fields no longer leak on unauthenticated requests.
      // It must be protected at the plugin layer just like any other /api/* route.
      const protectedRoutes = [
        { method: 'GET' as const, url: '/api/auth/admin-status' },
      ];
      for (const { method, url } of protectedRoutes) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url} should be 401`).toBe(401);
      }
    });

    it('admin endpoints are no longer API-key-reachable after de-god-moding (#1453) but pass with a session cookie', async () => {
      // Post-#1453 the API key only authenticates `/api/v*`, so `/api/auth/admin-status`
      // (a non-`v*` path) rejects an API-key-only request even when the key is valid.
      // A real non-key credential (forms session cookie) still authenticates it,
      // proving the route is protected-but-reachable, not in the public allowlist.
      const apiKeyService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        validateApiKey: vi.fn().mockResolvedValue(true),
        verifySessionCookie: vi.fn().mockReturnValue({
          payload: { username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 1000000 },
          shouldRenew: false,
        }),
      });
      const apiKeyApp = await createApp(apiKeyService);
      try {
        const keyRes = await apiKeyApp.inject({
          method: 'GET',
          url: '/api/auth/admin-status',
          headers: { 'x-api-key': 'valid-key' },
        });
        expect(keyRes.statusCode, 'API key must NOT reach a non-v* admin route').toBe(401);

        const cookieRes = await apiKeyApp.inject({
          method: 'GET',
          url: '/api/auth/admin-status',
          cookies: { narratorr_session: 'valid-cookie-value' },
        });
        // Route is not registered on this test app — passes the auth plugin then 404s,
        // but importantly NOT 401.
        expect(cookieRes.statusCode, 'session cookie should reach the route').not.toBe(401);
      } finally {
        await apiKeyApp.close();
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

    it('X-Api-Key header with valid key passes on /api/v* (in scope)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/test',
        headers: { 'x-api-key': 'valid-key' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('?apikey= query param with valid key passes on /api/v* (in scope)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/test?apikey=valid-key',
      });
      expect(res.statusCode).toBe(200);
    });

    it('valid key on a non-v* path is rejected with the API-key 401 body (de-god-moded #1453) — forms mode, no cookie', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { 'x-api-key': 'valid-key' },
      });
      expect(res.statusCode).toBe(401);
      // Contract: an API-key-only request outside /api/v* returns the canonical
      // API-key body, NOT the generic ambient 'Authentication required'.
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });

    it('valid key on /api/version-history (starts with v, not v+digit) is rejected with the API-key 401 body — not in scope', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/version-history',
        headers: { 'x-api-key': 'valid-key' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });

    it('valid key on bare /api/v1 classifies as in-scope (auth passes → 404, not 401)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      // No route registered at bare /api/v1 — an in-scope key passes auth and 404s
      // at routing. A 401 here would mean the matcher failed to treat it as in-scope.
      const res = await app.inject({ method: 'GET', url: '/api/v1', headers: { 'x-api-key': 'valid-key' } });
      expect(res.statusCode).not.toBe(401);
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
        expect(typeof calls[0]![0]).toBe('string');
      }
    });

    it('invalid API key on a native /api/v1/* route returns the 401 v1 envelope (#1472)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      // `/api/v1/test` is a generic in-scope route → classifies as native v1 under
      // the compat-exception discriminator, so it gets the v1 error envelope.
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/test',
        headers: { 'x-api-key': 'bad-key' },
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
      expect(v1ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
    });

    it('invalid API key on the compat /api/v1/system/status keeps the bare-string body (#1472)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/system/status',
        headers: { 'x-api-key': 'bad-key' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });

    it('invalid API key on the compat /api/v1/indexer keeps the bare-string body (#1472)', async () => {
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/indexer',
        headers: { 'x-api-key': 'bad-key' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });

    it('a thrown validateApiKey() on a native v1 route is NOT converted to the INVALID_API_KEY envelope (#1472)', async () => {
      // Operational config faults (uninitialized/parse/decrypt) surface as a throw,
      // which is a 500-class server fault — NOT "your key is invalid". The hook adds
      // no try/catch, so it propagates to the app-level handler unchanged.
      (authService.validateApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('auth config not initialized'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/test',
        headers: { 'x-api-key': 'bad-key' },
      });
      expect(res.statusCode).not.toBe(401);
      expect(JSON.parse(res.payload)).not.toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
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

    it('PUT /api/test-mutation passes without credentials in mode: none', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/test-mutation', payload: { version: '1.0.0' } });
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

    afterEach(() => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockReset();
    });

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

    it('rejects Basic auth when decoded string has no colon — full contract: 401, challenge header, error body, no verifyCredentials', async () => {
      const encoded = Buffer.from('useronly').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="Narratorr"');
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid credentials' });
      expect(authService.verifyCredentials).not.toHaveBeenCalled();
    });

    it('parses password with colons correctly — only splits on first colon', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });
      const encoded = Buffer.from('admin:p@ss:word:extra').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(200);
      expect(authService.verifyCredentials).toHaveBeenCalledWith('admin', 'p@ss:word:extra');
    });

    it('rejects empty username (base64 of ":password") with 401', async () => {
      const encoded = Buffer.from(':password').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(401);
      expect(authService.verifyCredentials).not.toHaveBeenCalled();
    });

    it('rejects empty decoded string with 401', async () => {
      const encoded = Buffer.from('').toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: `Basic ${encoded}` },
      });
      expect(res.statusCode).toBe(401);
      expect(authService.verifyCredentials).not.toHaveBeenCalled();
    });

    it('rejects non-base64 garbage — post-decode has no colon — returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: 'Basic !!!notbase64!!!' },
      });
      expect(res.statusCode).toBe(401);
      expect(authService.verifyCredentials).not.toHaveBeenCalled();
    });

    it('PUT /api/test-mutation returns 401 without credentials in mode: basic', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/test-mutation', payload: { version: '1.0.0' } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('mode: basic — CSRF protection', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'basic', hasUser: true, localBypass: false }),
        validateApiKey: vi.fn().mockResolvedValue(true),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    afterEach(() => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockReset();
    });

    function basicAuthHeader() {
      const encoded = Buffer.from('admin:password123').toString('base64');
      return `Basic ${encoded}`;
    }

    it('authenticated POST without X-Requested-With → 403 { error: /CSRF/ }', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        headers: { authorization: basicAuthHeader() },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
    });

    it('authenticated POST with X-Requested-With: XMLHttpRequest → reaches handler', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        headers: {
          authorization: basicAuthHeader(),
          'x-requested-with': 'XMLHttpRequest',
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('authenticated PUT without X-Requested-With → 403', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/test-mutation',
        headers: { authorization: basicAuthHeader() },
        payload: { version: '1.0.0' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
    });

    it('GET requests are exempt (safe method)', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: basicAuthHeader() },
      });

      expect(res.statusCode).toBe(200);
    });

    it('HEAD requests are exempt (safe method) — no CSRF gate, reaches handler', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'HEAD',
        url: '/api/test',
        headers: { authorization: basicAuthHeader() },
      });

      // Fastify auto-creates HEAD routes for GET handlers — verifies the auth plugin doesn't 403 on HEAD.
      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(403);
    });

    it('OPTIONS requests are exempt (safe method / CORS preflight) — no CSRF gate', async () => {
      (authService.verifyCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ username: 'admin' });

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/test',
        headers: { authorization: basicAuthHeader() },
      });

      // No OPTIONS handler is registered on the test app and no CORS plugin is wired in,
      // so Fastify returns 404. The contract under test is that the CSRF gate does NOT
      // turn this into a 403 — preflight requests must pass the auth plugin unblocked.
      expect(res.statusCode).not.toBe(403);
    });

    it('unauthenticated POST returns 401 + WWW-Authenticate (CSRF check does NOT preempt the auth challenge)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="Narratorr"');
    });

    it('valid X-Api-Key + POST to /api/v* without X-Requested-With → 200 (api-key CSRF bypass, in scope)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/test-mutation',
        headers: { 'x-api-key': 'valid-key' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('valid X-Api-Key + POST to a non-v* path is rejected with the API-key 401 body (de-god-moded) — basic mode, no header', async () => {
      // The key no longer reaches `/api/library/scan-debug`; with no Basic header
      // (the only credential is the out-of-scope key) the chain rejects with the
      // canonical API-key body, not the old api-key 200 bypass.
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        headers: { 'x-api-key': 'valid-key' },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
    });

    it('public route (POST /api/auth/login) is exempt — no CSRF check', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
      });
      // Route doesn't exist on the test app, so 404 — but NOT 403/401
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('public route (POST /api/auth/logout) is exempt — no CSRF check (logout is in BASE_PUBLIC_ROUTES)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('mode: basic — CORS preflight (browser OPTIONS)', () => {
    // Production registers @fastify/cors BEFORE authPlugin (see src/server/index.ts:67-121),
    // so a real browser preflight (OPTIONS + Origin + Access-Control-Request-Method,
    // *no* Authorization header) is intercepted by the cors plugin and never reaches the
    // auth dispatch hook. This test wires up that exact plugin order to prove the
    // preflight does NOT regress to 401 + WWW-Authenticate.
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'basic', hasUser: true, localBypass: false }),
      });

      app = Fastify({ logger: false });
      const { default: cors } = await import('@fastify/cors');
      // Production order: CORS first, cookie, then auth plugin.
      await app.register(cors, { origin: true, credentials: true });
      await app.register(cookie);
      await app.register(authPlugin, { authService });

      // POST /api/books — destination of a hypothetical cross-origin mutation;
      // the preflight is OPTIONS to this same route.
      app.post('/api/books', async () => ({ ok: true }));
      app.get('/api/books', async () => ({ ok: true }));

      await app.ready();
    });

    afterAll(async () => { await app.close(); });

    it('cross-origin OPTIONS preflight (no Authorization, with Origin + Access-Control-Request-Method) → 204, NOT 401, NOT 403', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/books',
        headers: {
          origin: 'http://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-requested-with,content-type',
        },
      });

      // @fastify/cors short-circuits the preflight with 204 before authPlugin runs.
      // The auth plugin must NOT 401 (no Basic challenge on a preflight) and must NOT 403
      // (no CSRF gate on a preflight). Both would break real cross-origin mutations.
      expect(res.statusCode).toBe(204);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('mode: forms — no CSRF requirement', () => {
    let app: FastifyInstance;
    let authService: AuthService;

    beforeAll(async () => {
      authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('authenticated POST without X-Requested-With → 200', async () => {
      (authService.verifySessionCookie as ReturnType<typeof vi.fn>).mockReturnValue({
        payload: { username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 1000000 },
        shouldRenew: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        cookies: { narratorr_session: 'valid-cookie-value' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('mode: none — no CSRF requirement', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'none', hasUser: false, localBypass: false }),
      });
      app = await createApp(authService);
    });

    afterAll(async () => { await app.close(); });

    it('POST without X-Requested-With → 200', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/library/scan-debug' });
      expect(res.statusCode).toBe(200);
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

    it('PUT /api/test-mutation returns 401 without session in mode: forms', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/test-mutation', payload: { version: '1.0.0' } });
      expect(res.statusCode).toBe(401);
    });

    it('cookie >50% TTL triggers re-set (sliding expiry) — dev mode never includes Secure', async () => {
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
      expect(String(setCookie)).toContain('HttpOnly');
      expect(String(setCookie)).toContain('SameSite=Lax');
      expect(String(setCookie)).not.toContain('Secure');
      expect(String(setCookie)).toContain('Path=/');
    });
  });

  describe('mode: forms — sliding renewal cookie security matrix', () => {
    function makeRenewingAuthService() {
      return createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        verifySessionCookie: vi.fn().mockReturnValue({
          payload: { username: 'admin', issuedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
          shouldRenew: true,
        }),
        createSessionCookie: vi.fn().mockReturnValue('renewed-cookie-value'),
      });
    }

    afterEach(() => {
      (config as { isDev: boolean }).isDev = true;
      delete (config as { urlBase?: string }).urlBase;
    });

    it('production + trusted proxy + X-Forwarded-Proto: https → renewal cookie has Secure', async () => {
      (config as { isDev: boolean }).isDev = false;
      const app = await createApp(makeRenewingAuthService(), { trustProxy: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('Secure');
      } finally {
        await app.close();
      }
    });

    it('production + trusted proxy + X-Forwarded-Proto: http → renewal cookie has no Secure', async () => {
      (config as { isDev: boolean }).isDev = false;
      const app = await createApp(makeRenewingAuthService(), { trustProxy: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
          headers: { 'x-forwarded-proto': 'http' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        await app.close();
      }
    });

    it('production + no trusted proxy → renewal cookie has no Secure (forwarded headers ignored)', async () => {
      (config as { isDev: boolean }).isDev = false;
      const app = await createApp(makeRenewingAuthService());
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        await app.close();
      }
    });

    it('URL_BASE=/narratorr → renewal cookie uses Path=/narratorr', async () => {
      (config as { urlBase?: string }).urlBase = '/narratorr';
      const app = await createApp(makeRenewingAuthService());
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('Path=/narratorr');
      } finally {
        await app.close();
      }
    });

    it('dev + trusted proxy + X-Forwarded-Proto: https → renewal cookie has no Secure', async () => {
      // isDev=true (default in mock); even if a trusted proxy reports HTTPS, dev mode short-circuits Secure to false.
      const app = await createApp(makeRenewingAuthService(), { trustProxy: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        await app.close();
      }
    });

    it('renewal Set-Cookie contains Max-Age=604800 (7-day persistent session)', async () => {
      const app = await createApp(makeRenewingAuthService());
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          cookies: { narratorr_session: 'old-cookie' },
        });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('Max-Age=604800');
      } finally {
        await app.close();
      }
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

  describe('local bypass with trustProxy', () => {
    function createBypassService(): AuthService {
      return createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: true }),
      });
    }

    it('trustProxy: false (default), private socket peer, no XFF → bypass triggers', async () => {
      const app = await createApp(createBypassService());
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '127.0.0.1',
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('trustProxy: false (baseline), private socket peer, public XFF → bypass triggers (XFF ignored)', async () => {
      const app = await createApp(createBypassService());
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.42' },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('trustProxy: ["10.0.0.0/8"], private socket peer, no XFF → bypass triggers (proxy IP itself private)', async () => {
      const app = await createApp(createBypassService(), { trustProxy: ['10.0.0.0/8'] });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '10.0.0.5',
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).ip).toBe('10.0.0.5');
      } finally {
        await app.close();
      }
    });

    it('trustProxy: ["10.0.0.0/8"], single trusted proxy, public client → bypass does NOT trigger', async () => {
      const app = await createApp(createBypassService(), { trustProxy: ['10.0.0.0/8'] });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.42' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('chained proxies, fully trusted → bypass does NOT trigger; request.ip resolves to public client', async () => {
      const app = await createApp(createBypassService(), {
        trustProxy: ['10.0.0.0/8', '192.168.0.0/16'],
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.42, 192.168.1.1' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('chained proxies, intermediate hop NOT trusted → request.ip falls back to private hop and bypass triggers', async () => {
      const app = await createApp(createBypassService(), { trustProxy: ['10.0.0.0/8'] });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.42, 192.168.1.1' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).ip).toBe('192.168.1.1');
      } finally {
        await app.close();
      }
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

    it('API-key v-scope is URL_BASE-aware: key on {base}/api/v1/* allowed, {base}/api/books rejected', async () => {
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        validateApiKey: vi.fn().mockResolvedValue(true),
      });
      const app = await createUrlBaseApp(authService, (a) => {
        a.get('/narratorr/api/v1/foo', async () => ({ ok: true }));
        a.get('/narratorr/api/books', async () => ({ ok: true }));
      });
      try {
        const inScope = await app.inject({ method: 'GET', url: '/narratorr/api/v1/foo', headers: { 'x-api-key': 'valid-key' } });
        expect(inScope.statusCode, 'key under {base}/api/v1 allowed').toBe(200);

        const outOfScope = await app.inject({ method: 'GET', url: '/narratorr/api/books', headers: { 'x-api-key': 'valid-key' } });
        expect(outOfScope.statusCode, 'key under {base}/api/books rejected').toBe(401);
        expect(JSON.parse(outOfScope.payload)).toEqual({ error: 'Invalid API key' });
      } finally {
        await app.close();
      }
    });

    it('invalid key on a native {base}/api/v1/* route returns the v1 envelope; compat shim stays bare-string (#1472)', async () => {
      // Proves the envelope discriminator is URL_BASE-prefix-derived, not a hardcoded
      // `/api/` literal: native vs compat must classify correctly under URL_BASE too.
      const authService = createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        validateApiKey: vi.fn().mockResolvedValue(false),
      });
      const app = await createUrlBaseApp(authService, (a) => {
        a.get('/narratorr/api/v1/foo', async () => ({ ok: true }));
        a.get('/narratorr/api/v1/system/status', async () => ({ ok: true }));
      });
      try {
        const native = await app.inject({ method: 'GET', url: '/narratorr/api/v1/foo', headers: { 'x-api-key': 'bad-key' } });
        expect(native.statusCode).toBe(401);
        expect(JSON.parse(native.payload)).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });

        const compat = await app.inject({ method: 'GET', url: '/narratorr/api/v1/system/status', headers: { 'x-api-key': 'bad-key' } });
        expect(compat.statusCode).toBe(401);
        expect(JSON.parse(compat.payload)).toEqual({ error: 'Invalid API key' });
      } finally {
        await app.close();
      }
    });
  });

  // #1453 — stream-token + de-god-moded API-key auth-mode matrix on the SSE
  // endpoints (`/api/events`, `/api/search/stream`) and the cancel route.
  describe('stream token + SSE auth matrix (#1453)', () => {
    const VALID_TOKEN = 'valid-stream-token';

    function createStreamApp(modeStatus: Record<string, unknown> = { mode: 'forms', hasUser: true, localBypass: false }) {
      return createMockAuthService({
        getStatus: vi.fn().mockResolvedValue(modeStatus),
        validateApiKey: vi.fn().mockResolvedValue(true),
        verifyStreamToken: vi.fn().mockImplementation((token: string) =>
          token === VALID_TOKEN ? { kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } : null),
        verifySessionCookie: vi.fn().mockReturnValue(null),
      });
    }

    const SSE_PATHS = ['/api/events', '/api/search/stream'];

    it('valid stream token authenticates both SSE endpoints (forms mode)', async () => {
      const app = await createApp(createStreamApp());
      try {
        for (const path of SSE_PATHS) {
          const res = await app.inject({ method: 'GET', url: `${path}?token=${VALID_TOKEN}` });
          // No SSE route registered on the test app → auth passes then 404. Not 401.
          expect(res.statusCode, `${path} accepts stream token`).not.toBe(401);
        }
      } finally {
        await app.close();
      }
    });

    it('API-key-only is rejected with the API-key 401 body on both SSE endpoints and the cancel route', async () => {
      const app = await createApp(createStreamApp());
      try {
        for (const path of SSE_PATHS) {
          const res = await app.inject({ method: 'GET', url: path, headers: { 'x-api-key': 'valid-key' } });
          expect(res.statusCode, `${path} rejects API key`).toBe(401);
          expect(JSON.parse(res.payload), `${path} returns the API-key contract body`).toEqual({ error: 'Invalid API key' });
        }
        const cancel = await app.inject({
          method: 'POST',
          url: '/api/search/stream/sess/cancel/1',
          headers: { 'x-api-key': 'valid-key' },
        });
        expect(cancel.statusCode, 'cancel route rejects API key').toBe(401);
        expect(JSON.parse(cancel.payload)).toEqual({ error: 'Invalid API key' });
      } finally {
        await app.close();
      }
    });

    it('a stream token does NOT authenticate the mint route or the cancel route', async () => {
      const app = await createApp(createStreamApp());
      try {
        // Mint is not an SSE endpoint → stream-token branch never runs → forms 401.
        const mint = await app.inject({ method: 'POST', url: `/api/auth/stream-token?token=${VALID_TOKEN}` });
        expect(mint.statusCode, 'mint rejects stream token').toBe(401);
        // Cancel route is not in STREAM_ROUTES → stream token not accepted.
        const cancel = await app.inject({ method: 'POST', url: `/api/search/stream/sess/cancel/1?token=${VALID_TOKEN}` });
        expect(cancel.statusCode, 'cancel rejects stream token').toBe(401);
      } finally {
        await app.close();
      }
    });

    it('a stale ?apikey= does NOT shadow a valid stream token on the SSE endpoints', async () => {
      const app = await createApp(createStreamApp());
      try {
        for (const path of SSE_PATHS) {
          const res = await app.inject({ method: 'GET', url: `${path}?apikey=stale-key&token=${VALID_TOKEN}` });
          expect(res.statusCode, `${path} token wins over stale apikey`).not.toBe(401);
        }
      } finally {
        await app.close();
      }
    });

    it('a stale ?apikey= does NOT shadow a valid session cookie on the SSE endpoints', async () => {
      // Valid forms cookie; no stream token present; a stale apikey is also in the URL.
      const cookieApp = await createApp(createMockAuthService({
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        validateApiKey: vi.fn().mockResolvedValue(true),
        verifySessionCookie: vi.fn().mockReturnValue({
          payload: { username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 1000000 },
          shouldRenew: false,
        }),
      }));
      try {
        for (const path of SSE_PATHS) {
          const res = await cookieApp.inject({
            method: 'GET',
            url: `${path}?apikey=stale-key`,
            cookies: { narratorr_session: 'valid-cookie' },
          });
          expect(res.statusCode, `${path} cookie wins over stale apikey`).not.toBe(401);
        }
      } finally {
        await cookieApp.close();
      }
    });

    it('none mode: SSE endpoints, mint, and cancel are all open', async () => {
      const app = await createApp(createStreamApp({ mode: 'none', hasUser: false, localBypass: false }));
      try {
        for (const path of SSE_PATHS) {
          const res = await app.inject({ method: 'GET', url: path });
          expect(res.statusCode, `${path} open in none mode`).not.toBe(401);
        }
        const cancel = await app.inject({ method: 'POST', url: '/api/search/stream/sess/cancel/1' });
        expect(cancel.statusCode, 'cancel open in none mode').not.toBe(401);
      } finally {
        await app.close();
      }
    });

    it('unauthenticated (forms, no creds) is rejected on the SSE endpoints', async () => {
      const app = await createApp(createStreamApp());
      try {
        for (const path of SSE_PATHS) {
          const res = await app.inject({ method: 'GET', url: path });
          expect(res.statusCode, `${path} rejects unauthenticated`).toBe(401);
        }
      } finally {
        await app.close();
      }
    });
  });
});
