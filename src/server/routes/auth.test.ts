import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { authRoutes } from './auth.js';
import { settingsRoutes } from './settings.js';
import authPlugin from '../plugins/auth.js';
import type { AuthService } from '../services/auth.service.js';

vi.mock('../config.js', () => ({
  config: {
    isDev: true,
  },
}));

import { config } from '../config.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError, NoCredentialsError } from '../services/auth.service.js';

/** Creates a test app with @fastify/cookie + auth routes + a hook that sets request.user. */
async function createAuthTestApp(
  services: Services,
  fastifyOpts: FastifyServerOptions = {},
) {
  const app = Fastify({ logger: false, ...fastifyOpts }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);

  // Simulate auth middleware: set request.user for protected routes
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    // Set a default authenticated user for all requests (simulates auth pass)
    request.user = { username: 'admin' };
  });

  await authRoutes(app, services.auth as Parameters<typeof authRoutes>[1]);
  await settingsRoutes(app, services.settings as Parameters<typeof settingsRoutes>[1]);
  await app.ready();
  return app;
}

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof createAuthTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createAuthTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/auth/status (#742 — minimal public payload)', () => {
    it('returns exactly { mode, authenticated } for none mode', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'none',
        hasUser: false,
        localBypass: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ mode: 'none', authenticated: true });
      expect(Object.keys(body).sort()).toEqual(['authenticated', 'mode']);
    });

    it('omits hasUser, username, localBypass, bypassActive, envBypass on every response', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'forms',
        hasUser: true,
        username: 'admin',
        localBypass: true,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).not.toHaveProperty('hasUser');
      expect(body).not.toHaveProperty('username');
      expect(body).not.toHaveProperty('localBypass');
      expect(body).not.toHaveProperty('bypassActive');
      expect(body).not.toHaveProperty('envBypass');
    });

    it('returns authenticated: false for forms mode without session cookie', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'forms',
        hasUser: true,
        localBypass: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.authenticated).toBe(false);
    });

    it('returns authenticated: true for forms mode with valid session cookie', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'forms',
        hasUser: true,
        localBypass: false,
      });
      (services.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
      (services.auth.verifySessionCookie as Mock).mockReturnValue({ username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 86400000 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        cookies: { narratorr_session: 'valid-cookie-value' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.authenticated).toBe(true);
      expect(services.auth.verifySessionCookie).toHaveBeenCalledWith('valid-cookie-value', 'test-secret');
    });
  });

  describe('GET /api/auth/admin-status (#742 — authenticated admin surface)', () => {
    it('returns hasUser, username, localBypass, bypassActive, envBypass', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'forms',
        hasUser: true,
        username: 'admin',
        localBypass: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/admin-status' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.hasUser).toBe(true);
      expect(body.username).toBe('admin');
      expect(body.localBypass).toBe(false);
      expect(body.bypassActive).toBe(false);
      expect(body.envBypass).toBe(false);
    });

    it('reports envBypass: true and bypassActive: true when AUTH_BYPASS env var is active', async () => {
      (config as Record<string, unknown>).authBypass = true;
      (services.auth.getStatus as Mock).mockResolvedValue({ mode: 'none', hasUser: false, localBypass: false });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/auth/admin-status' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.envBypass).toBe(true);
        expect(body.bypassActive).toBe(true);
      } finally {
        (config as Record<string, unknown>).authBypass = false;
      }
    });

    it('reports bypassActive: true for private IP when localBypass enabled', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: true });
      const res = await app.inject({ method: 'GET', url: '/api/auth/admin-status', remoteAddress: '192.168.1.5' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.bypassActive).toBe(true);
      expect(body.envBypass).toBe(false);
    });
  });

  describe('POST /api/auth/login', () => {
    it('with valid credentials sets httpOnly session cookie, returns success', async () => {
      (services.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      (services.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
      (services.auth.createSessionCookie as Mock).mockReturnValue('signed-cookie-value');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'password123' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(String(setCookie)).toContain('narratorr_session=signed-cookie-value');
      expect(String(setCookie)).toContain('HttpOnly');
    });

    it('with invalid credentials returns 401, no cookie set', async () => {
      (services.auth.verifyCredentials as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrongpass' },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid credentials' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(String(setCookie)).toContain('narratorr_session=');
    });
  });

  describe('POST /api/auth/logout — cookie security', () => {
    it('logout clears cookie with HttpOnly flag', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('HttpOnly');
    });

    it('logout clears cookie with SameSite=Lax', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('logout clears cookie with Path=/', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('Path=/');
    });

    it('logout clearCookie attributes match setCookie attributes from login', async () => {
      // Login first to get the login cookie attributes
      (services.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      (services.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
      (services.auth.createSessionCookie as Mock).mockReturnValue('signed-cookie-value');

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'password123' },
      });
      const loginCookie = String(loginRes.headers['set-cookie']);

      // Logout
      const logoutRes = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      const logoutCookie = String(logoutRes.headers['set-cookie']);

      // Both should have the same security attributes
      for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/']) {
        expect(loginCookie, `login cookie missing ${attr}`).toContain(attr);
        expect(logoutCookie, `logout cookie missing ${attr}`).toContain(attr);
      }

      // In dev mode (isDev=true), neither should have Secure
      expect(loginCookie).not.toContain('Secure');
      expect(logoutCookie).not.toContain('Secure');
    });

    it('login and logout cookies do not include Secure flag in dev mode', async () => {
      // isDev=true (default) — Secure must never be set even with trustProxy + X-Forwarded-Proto: https
      const devServices = createMockServices();
      const devApp = await createAuthTestApp(devServices, { trustProxy: true });

      try {
        (devServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
        (devServices.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
        (devServices.auth.createSessionCookie as Mock).mockReturnValue('signed-cookie');

        const loginRes = await devApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'pass' },
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(String(loginRes.headers['set-cookie'])).not.toContain('Secure');

        const logoutRes = await devApp.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(String(logoutRes.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        await devApp.close();
      }
    });
  });

  describe('POST /api/auth/setup', () => {
    it('creates user when no user exists (public)', async () => {
      (services.auth.createUser as Mock).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'password1234' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(services.auth.createUser).toHaveBeenCalledWith('admin', 'password1234');
    });

    it('requires auth when user already exists', async () => {
      (services.auth.createUser as Mock).mockRejectedValue(new UserExistsError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'password1234' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'User already exists' });
    });

    it('accepts 1-char password', async () => {
      (services.auth.createUser as Mock).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'x' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.auth.createUser).toHaveBeenCalledWith('admin', 'x');
    });

    it('rejects empty password with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/auth/config', () => {
    it('requires auth, returns { mode, apiKey, localBypass } (no sessionSecret)', async () => {
      (services.auth.getConfig as Mock).mockResolvedValue({
        mode: 'none',
        apiKey: 'test-api-key-123',
        localBypass: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/config' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ mode: 'none', apiKey: 'test-api-key-123', localBypass: false });
      expect(body.sessionSecret).toBeUndefined();
    });
  });

  describe('PUT /api/auth/config', () => {
    it('requires auth, updates mode', async () => {
      (services.auth.updateConfig as Mock).mockResolvedValue({
        mode: 'forms',
        apiKey: 'test-key',
        localBypass: false,
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/config',
        payload: { mode: 'forms' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).mode).toBe('forms');
    });

    it('rejects forms/basic mode when no credentials exist', async () => {
      (services.auth.updateConfig as Mock).mockRejectedValue(
        new AuthConfigError(),
      );

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/config',
        payload: { mode: 'forms' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('without credentials');
    });
  });

  describe('PUT /api/auth/password', () => {
    it('requires auth, validates current password', async () => {
      (services.auth.changePassword as Mock).mockRejectedValue(
        new IncorrectPasswordError(),
      );

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        payload: { currentPassword: 'wrong', newPassword: 'newpassword1' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Current password is incorrect');
    });

    it('returns 500 for generic service error', async () => {
      (services.auth.changePassword as Mock).mockRejectedValue(
        new Error('DB connection lost'),
      );

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        payload: { currentPassword: 'old', newPassword: 'newpassword1' },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('accepts 1-char newPassword', async () => {
      (services.auth.changePassword as Mock).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        payload: { currentPassword: 'old', newPassword: 'x' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.auth.changePassword).toHaveBeenCalledWith('admin', 'old', 'x', undefined);
    });

    it('rejects empty newPassword with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        payload: { currentPassword: 'old', newPassword: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/auth/api-key/regenerate', () => {
    it('requires auth, returns new key', async () => {
      (services.auth.regenerateApiKey as Mock).mockResolvedValue('new-api-key-456');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/api-key/regenerate',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ apiKey: 'new-api-key-456' });
    });

    it('returns 500 when regenerateApiKey throws', async () => {
      (services.auth.regenerateApiKey as Mock).mockRejectedValue(
        new Error('DB error'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/api-key/regenerate',
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });
  });

  describe('GET /api/auth/admin-status — bypassActive with trustProxy', () => {
    it('with trustProxy + private socket peer + public XFF → bypassActive: false', async () => {
      const trustedServices = createMockServices();
      const trustedApp = await createAuthTestApp(trustedServices, { trustProxy: ['10.0.0.0/8'] });
      try {
        (trustedServices.auth.getStatus as Mock).mockResolvedValue({
          mode: 'forms', hasUser: true, localBypass: true,
        });
        const res = await trustedApp.inject({
          method: 'GET',
          url: '/api/auth/admin-status',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.42' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).bypassActive).toBe(false);
      } finally {
        await trustedApp.close();
      }
    });

    it('with trustProxy + private socket peer + no XFF → bypassActive: true', async () => {
      const trustedServices = createMockServices();
      const trustedApp = await createAuthTestApp(trustedServices, { trustProxy: ['10.0.0.0/8'] });
      try {
        (trustedServices.auth.getStatus as Mock).mockResolvedValue({
          mode: 'forms', hasUser: true, localBypass: true,
        });
        const res = await trustedApp.inject({
          method: 'GET',
          url: '/api/auth/admin-status',
          remoteAddress: '10.0.0.5',
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).bypassActive).toBe(true);
      } finally {
        await trustedApp.close();
      }
    });
  });

  describe('DELETE /api/auth/credentials', () => {
    it('returns 200 and deletes user when AUTH_BYPASS is active', async () => {
      (config as Record<string, unknown>).authBypass = true;
      try {
        const res = await app.inject({ method: 'DELETE', url: '/api/auth/credentials' });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ success: true });
        expect(services.auth.deleteCredentials).toHaveBeenCalled();
      } finally {
        (config as Record<string, unknown>).authBypass = false;
      }
    });

    it('returns 403 when AUTH_BYPASS is not active', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/auth/credentials' });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Only available when AUTH_BYPASS is active' });
    });

    it('returns 404 when no user exists and AUTH_BYPASS is active', async () => {
      (config as Record<string, unknown>).authBypass = true;
      (services.auth.deleteCredentials as Mock).mockRejectedValue(new NoCredentialsError());
      try {
        const res = await app.inject({ method: 'DELETE', url: '/api/auth/credentials' });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload)).toEqual({ error: 'No credentials configured' });
      } finally {
        (config as Record<string, unknown>).authBypass = false;
      }
    });

    it('returns 500 for unexpected service errors when AUTH_BYPASS is active', async () => {
      (config as Record<string, unknown>).authBypass = true;
      (services.auth.deleteCredentials as Mock).mockRejectedValue(new Error('db down'));
      try {
        const res = await app.inject({ method: 'DELETE', url: '/api/auth/credentials' });
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
      } finally {
        (config as Record<string, unknown>).authBypass = false;
      }
    });
  });

  describe('cookie security matrix — Secure flag', () => {
    function loginPayload() {
      return { username: 'admin', password: 'pass' };
    }

    async function setupProdApp(trustProxy: boolean) {
      (config as { isDev: boolean }).isDev = false;
      const prodServices = createMockServices();
      const prodApp = await createAuthTestApp(prodServices, trustProxy ? { trustProxy: true } : {});
      (prodServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      (prodServices.auth.getSessionSecret as Mock).mockResolvedValue('secret');
      (prodServices.auth.createSessionCookie as Mock).mockReturnValue('cookie-val');
      return { prodApp, prodServices };
    }

    it('production + trusted proxy + X-Forwarded-Proto: https → Secure on login and logout', async () => {
      const { prodApp } = await setupProdApp(true);
      try {
        const loginRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: loginPayload(),
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(loginRes.statusCode).toBe(200);
        expect(String(loginRes.headers['set-cookie'])).toContain('Secure');

        const logoutRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(logoutRes.statusCode).toBe(200);
        expect(String(logoutRes.headers['set-cookie'])).toContain('Secure');
      } finally {
        (config as { isDev: boolean }).isDev = true;
        await prodApp.close();
      }
    });

    it('production + trusted proxy + X-Forwarded-Proto: http → no Secure on login and logout', async () => {
      const { prodApp } = await setupProdApp(true);
      try {
        const loginRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: loginPayload(),
          headers: { 'x-forwarded-proto': 'http' },
        });
        expect(loginRes.statusCode).toBe(200);
        expect(String(loginRes.headers['set-cookie'])).not.toContain('Secure');

        const logoutRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { 'x-forwarded-proto': 'http' },
        });
        expect(logoutRes.statusCode).toBe(200);
        expect(String(logoutRes.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        (config as { isDev: boolean }).isDev = true;
        await prodApp.close();
      }
    });

    it('production + no trusted proxy → no Secure (forwarded headers ignored)', async () => {
      const { prodApp } = await setupProdApp(false);
      try {
        const loginRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: loginPayload(),
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(loginRes.statusCode).toBe(200);
        expect(String(loginRes.headers['set-cookie'])).not.toContain('Secure');

        const logoutRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(logoutRes.statusCode).toBe(200);
        expect(String(logoutRes.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        (config as { isDev: boolean }).isDev = true;
        await prodApp.close();
      }
    });

    it('dev mode → never Secure regardless of X-Forwarded-Proto', async () => {
      const devServices = createMockServices();
      const devApp = await createAuthTestApp(devServices, { trustProxy: true });
      (devServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      (devServices.auth.getSessionSecret as Mock).mockResolvedValue('secret');
      (devServices.auth.createSessionCookie as Mock).mockReturnValue('cookie-val');
      try {
        const loginRes = await devApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: loginPayload(),
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(String(loginRes.headers['set-cookie'])).not.toContain('Secure');

        const logoutRes = await devApp.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(String(logoutRes.headers['set-cookie'])).not.toContain('Secure');
      } finally {
        await devApp.close();
      }
    });
  });

  describe('cookie path — URL_BASE awareness', () => {
    it('URL_BASE=/narratorr → login and logout Set-Cookie use Path=/narratorr', async () => {
      (config as { urlBase?: string }).urlBase = '/narratorr';
      const urlBaseServices = createMockServices();
      const urlBaseApp = await createAuthTestApp(urlBaseServices);
      try {
        (urlBaseServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
        (urlBaseServices.auth.getSessionSecret as Mock).mockResolvedValue('secret');
        (urlBaseServices.auth.createSessionCookie as Mock).mockReturnValue('cookie-val');

        const loginRes = await urlBaseApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'pass' },
        });
        expect(loginRes.statusCode).toBe(200);
        expect(String(loginRes.headers['set-cookie'])).toContain('Path=/narratorr');

        const logoutRes = await urlBaseApp.inject({ method: 'POST', url: '/api/auth/logout' });
        expect(logoutRes.statusCode).toBe(200);
        expect(String(logoutRes.headers['set-cookie'])).toContain('Path=/narratorr');
      } finally {
        delete (config as { urlBase?: string }).urlBase;
        await urlBaseApp.close();
      }
    });

    it('URL_BASE unset → Set-Cookie uses Path=/', async () => {
      // Default config mock has no urlBase; helper falls back to '/'.
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(String(res.headers['set-cookie'])).toContain('Path=/');
      expect(String(res.headers['set-cookie'])).not.toContain('Path=/narratorr');
    });
  });

  describe('cookie Max-Age contract', () => {
    it('login Set-Cookie contains Max-Age=604800 (7-day session)', async () => {
      (services.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      (services.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
      (services.auth.createSessionCookie as Mock).mockReturnValue('signed-cookie-value');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'password123' },
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=604800');
    });

    it('logout Set-Cookie does NOT contain Max-Age=604800 (clears, does not extend)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['set-cookie'])).not.toContain('Max-Age=604800');
    });
  });

  describe('CSRF protection — basic-auth mode', () => {
    let csrfApp: FastifyInstance;
    let csrfServices: Services;
    const basicAuthHeader = `Basic ${Buffer.from('admin:password123').toString('base64')}`;

    beforeAll(async () => {
      csrfServices = createMockServices();
      const authSvc = csrfServices.auth as unknown as Record<string, Mock>;
      authSvc.getStatus = vi.fn().mockResolvedValue({ mode: 'basic', hasUser: true, localBypass: false });
      authSvc.verifyCredentials = vi.fn().mockResolvedValue({ username: 'admin' });
      authSvc.validateApiKey = vi.fn().mockResolvedValue(false);

      csrfApp = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      csrfApp.setValidatorCompiler(validatorCompiler);
      csrfApp.setSerializerCompiler(serializerCompiler);
      await csrfApp.register(cookie);
      const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
      await csrfApp.register(errorHandlerPlugin);
      await csrfApp.register(authPlugin, { authService: csrfServices.auth as unknown as AuthService });
      await authRoutes(csrfApp, csrfServices.auth as Parameters<typeof authRoutes>[1]);
      await csrfApp.ready();
    });

    afterAll(async () => { await csrfApp.close(); });

    it('PUT /api/auth/config without X-Requested-With → 403', async () => {
      const res = await csrfApp.inject({
        method: 'PUT',
        url: '/api/auth/config',
        headers: { authorization: basicAuthHeader },
        payload: { mode: 'forms' },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
    });

    it('POST /api/auth/api-key/regenerate without X-Requested-With → 403', async () => {
      const res = await csrfApp.inject({
        method: 'POST',
        url: '/api/auth/api-key/regenerate',
        headers: { authorization: basicAuthHeader },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
    });

    it('POST /api/auth/api-key/regenerate with X-Requested-With reaches the handler', async () => {
      (csrfServices.auth.regenerateApiKey as Mock).mockResolvedValue('new-key-xyz');
      const res = await csrfApp.inject({
        method: 'POST',
        url: '/api/auth/api-key/regenerate',
        headers: {
          authorization: basicAuthHeader,
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ apiKey: 'new-key-xyz' });
    });

    it('POST /api/auth/login (public) without X-Requested-With reaches handler — public route exempt', async () => {
      (csrfServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
      const res = await csrfApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'password123' },
      });
      // Reaches handler — login route is public.
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/auth/logout (public) without X-Requested-With reaches handler — verifies logout in BASE_PUBLIC_ROUTES', async () => {
      const res = await csrfApp.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('settings isolation', () => {
    it('GET /api/settings does NOT include any auth config', async () => {
      (services.settings.getAll as Mock).mockResolvedValue({
        library: { path: '/audiobooks' },
        search: { enabled: true },
      });

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.auth).toBeUndefined();
      expect(body.apiKey).toBeUndefined();
      expect(body.sessionSecret).toBeUndefined();
    });
  });
});
