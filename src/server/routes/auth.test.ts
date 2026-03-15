import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify from 'fastify';
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

vi.mock('../config.js', () => ({
  config: {
    isDev: true,
  },
}));

import { config } from '../config.js';

/** Creates a test app with @fastify/cookie + auth routes + a hook that sets request.user. */
async function createAuthTestApp(services: Services) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);

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

  describe('GET /api/auth/status', () => {
    it('returns { mode, hasUser, localBypass, authenticated } for none mode', async () => {
      (services.auth.getStatus as Mock).mockResolvedValue({
        mode: 'none',
        hasUser: false,
        localBypass: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ mode: 'none', hasUser: false, localBypass: false, authenticated: true });
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

    it('logout cookie includes Secure flag in production mode', async () => {
      // Switch to production mode
      (config as { isDev: boolean }).isDev = false;

      // Need a fresh app for the config change to take effect in route handler
      const prodServices = createMockServices();
      const prodApp = await createAuthTestApp(prodServices);

      try {
        // Login
        (prodServices.auth.verifyCredentials as Mock).mockResolvedValue({ username: 'admin' });
        (prodServices.auth.getSessionSecret as Mock).mockResolvedValue('test-secret');
        (prodServices.auth.createSessionCookie as Mock).mockReturnValue('signed-cookie');

        const loginRes = await prodApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'pass' },
        });
        expect(String(loginRes.headers['set-cookie'])).toContain('Secure');

        // Logout should also have Secure
        const logoutRes = await prodApp.inject({ method: 'POST', url: '/api/auth/logout' });
        expect(String(logoutRes.headers['set-cookie'])).toContain('Secure');
      } finally {
        (config as { isDev: boolean }).isDev = true;
        await prodApp.close();
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
      (services.auth.createUser as Mock).mockRejectedValue(new Error('User already exists'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'password1234' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'User already exists' });
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
        new Error('Cannot enable auth mode without credentials configured'),
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
        new Error('Current password is incorrect'),
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
