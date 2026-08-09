import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import { v1CapabilitiesRoutes } from './capabilities.js';
import { v1SystemRoutes } from './system.js';
import { capabilitiesV1Schema } from '@shared/schemas/v1/capabilities.js';

// Run the auth plugin with authBypass off.
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

const authService = {
  validateApiKey: vi.fn().mockResolvedValue(true),
  getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
  hasUser: vi.fn().mockResolvedValue(true),
  verifyCredentials: vi.fn().mockResolvedValue(null),
  getSessionSecret: vi.fn().mockResolvedValue('secret'),
  verifySessionCookie: vi.fn().mockReturnValue(null),
  verifyStreamToken: vi.fn().mockReturnValue(null),
  createSessionCookie: vi.fn().mockReturnValue('cookie'),
} as unknown as AuthService;

const settingsService = { get: vi.fn() } as unknown as SettingsService;

describe('v1 capabilities route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1CapabilitiesRoutes(app, { settingsService });
    await v1SystemRoutes(app);
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (settingsService.get as Mock).mockResolvedValue({ enabled: false });
  });

  async function get() {
    return app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: keyHeaders });
  }

  describe('GET /api/v1/capabilities', () => {
    it('reports enabled: true from the parsed companionEpub settings category (AC 3)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ enabled: true });

      const res = await get();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ companionEpub: { enabled: true } });
      expect(settingsService.get as Mock).toHaveBeenCalledTimes(1);
      expect(settingsService.get as Mock).toHaveBeenCalledWith('companionEpub');
    });

    it('reports enabled: false when the feature is off', async () => {
      (settingsService.get as Mock).mockResolvedValue({ enabled: false });

      const res = await get();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ companionEpub: { enabled: false } });
    });

    it('fails CLOSED to { enabled: false } with a warn — never a 5xx — when the settings read rejects (AC 4)', async () => {
      (settingsService.get as Mock).mockRejectedValue(new Error('settings db down'));
      // With logger:false, request.log delegates to app.log.
      const warnSpy = vi.spyOn(app.log, 'warn');

      const res = await get();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ companionEpub: { enabled: false } });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        expect.stringContaining('capabilities'),
      );
      warnSpy.mockRestore();
    });

    it('round-trips the body through the strict capabilitiesV1Schema', async () => {
      const body = (await get()).json();
      expect(capabilitiesV1Schema.safeParse(body).success).toBe(true);
      expect(Object.keys(body)).toEqual(['companionEpub']);
      expect(Object.keys(body.companionEpub)).toEqual(['enabled']);
    });
  });

  describe('auth (inherited from the global /api/v* onRequest hook — AC 5)', () => {
    it('rejects a missing API key with 401 (ambient body, not the v1 envelope)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a presented-but-invalid API key with the 401 v1 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
    });
  });

  describe('GET /api/v1/system is unchanged (AC 6)', () => {
    it('returns exactly the five system fields, with no companionEpub or capability key', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['buildTime', 'commit', 'nodeVersion', 'os', 'version']);
      expect(body).not.toHaveProperty('companionEpub');
      expect(body).not.toHaveProperty('capabilities');
    });
  });

  // Older servers signal unsupported with an authenticated 404. Keyless probes fail auth first
  // and cannot distinguish feature support.
  describe('404 signal channel for an unregistered v1 path (AC 9a)', () => {
    const UNREGISTERED = '/api/v1/definitely-not-a-route';

    it('returns 404 for an AUTHENTICATED request to an unregistered /api/v1/* path', async () => {
      const res = await app.inject({ method: 'GET', url: UNREGISTERED, headers: keyHeaders });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 — NOT 404 — for an unauthenticated request to the same path', async () => {
      const res = await app.inject({ method: 'GET', url: UNREGISTERED });
      expect(res.statusCode).toBe(401);
      expect(res.statusCode).not.toBe(404);
    });

    it('an unmatched route never enters the encapsulated v1 plugin, so the 404 body is ambient (consumers key on the STATUS)', async () => {
      const res = await app.inject({ method: 'GET', url: UNREGISTERED, headers: keyHeaders });
      expect(res.json()).not.toHaveProperty('error.code');
    });
  });
});

// Strictness must fail closed at both schema levels and through Fastify serialization.
describe('strict / fail-closed schema at both levels (AC 2, F13)', () => {
  const valid = { companionEpub: { enabled: true } };

  it('capabilitiesV1Schema.parse accepts the exact shape', () => {
    expect(capabilitiesV1Schema.safeParse(valid).success).toBe(true);
  });

  it('rejects an extra TOP-LEVEL key instead of stripping it', () => {
    expect(capabilitiesV1Schema.safeParse({ ...valid, companionPdf: { enabled: true } }).success).toBe(false);
  });

  it('rejects an extra key INSIDE companionEpub instead of stripping it', () => {
    expect(
      capabilitiesV1Schema.safeParse({ companionEpub: { enabled: true, libraryPath: '/media' } }).success,
    ).toBe(false);
  });

  it.each([
    ['top-level', { ...valid, companionPdf: { enabled: true } }],
    ['nested inside companionEpub', { companionEpub: { enabled: true, libraryPath: '/media' } }],
  ])('Fastify serialization fails closed (500) on an extra %s key', async (_label, leaky) => {
    const leakyApp = Fastify({ logger: false });
    leakyApp.setSerializerCompiler(serializerCompiler);
    leakyApp.get('/leak', { schema: { response: { 200: capabilitiesV1Schema } } }, async () => leaky);
    await leakyApp.ready();

    const res = await leakyApp.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('companionPdf');

    await leakyApp.close();
  });
});
