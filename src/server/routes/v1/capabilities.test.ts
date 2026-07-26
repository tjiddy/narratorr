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
import { capabilitiesV1Schema } from '../../../shared/schemas/v1/capabilities.js';

// Mock config so the auth plugin runs with authBypass off (mirrors system.test).
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
    // Registered alongside so the "/api/v1/system is unchanged" regression (AC 6)
    // runs against the same composition a real server has.
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
      // Sourced from the parsed settings category, never a raw settings row read.
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
      // With logger:false the abstract logger is a singleton, so request.log
      // delegates to app.log (the metadata.test precedent).
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

  // AC 6 — `/api/v1/system` is a documented stable five-field contract and this
  // issue does NOT touch it. Capability discovery lives at its own endpoint.
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

  // AC 9a — the producer side of the older-server "unsupported" signal. An older
  // Narratorr has no `/api/v1/capabilities` route, so the consumer's signal is
  // that server's ambient 404. This repo cannot run an older build; what it CAN
  // own is that on the current server's routing/auth ordering the signal is a
  // `404` for a KEYED probe and a `401` for a keyless one — so the consumer must
  // probe with a valid API key and must never read `401` as "unsupported".
  describe('404 signal channel for an unregistered v1 path (AC 9a)', () => {
    const UNREGISTERED = '/api/v1/definitely-not-a-route';

    it('returns 404 for an AUTHENTICATED request to an unregistered /api/v1/* path', async () => {
      const res = await app.inject({ method: 'GET', url: UNREGISTERED, headers: keyHeaders });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 — NOT 404 — for an unauthenticated request to the same path', async () => {
      // The auth hook runs `onRequest`, before routing, so a keyless probe cannot
      // distinguish "feature unsupported" from "auth problem".
      const res = await app.inject({ method: 'GET', url: UNREGISTERED });
      expect(res.statusCode).toBe(401);
      expect(res.statusCode).not.toBe(404);
    });

    it('an unmatched route never enters the encapsulated v1 plugin, so the 404 body is ambient (consumers key on the STATUS)', async () => {
      const res = await app.inject({ method: 'GET', url: UNREGISTERED, headers: keyHeaders });
      // `v1ErrorHandler` did not run — no `{ error: { code, message } }` envelope.
      expect(res.json()).not.toHaveProperty('error.code');
    });
  });
});

// AC 2 / F13 — `.strict()` at BOTH levels. One fixture can only prove one level,
// so each level gets its own fail-closed case at BOTH layers: a direct parse and
// Fastify response serialization (which must 500 rather than strip-and-ship).
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
