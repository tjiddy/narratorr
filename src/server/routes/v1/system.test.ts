import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import { v1SystemRoutes } from './system.js';
import { systemV1Schema } from '@shared/schemas/v1/system.js';
import { getVersion, getCommit, getBuildTime } from '../../utils/version.js';

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

function expectV1Envelope(body: unknown): void {
  expect(body).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
}

describe('v1 system route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1SystemRoutes(app);
    app.get('/api/v1/system/status', async () => ({ compat: true }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
  });

  describe('GET /api/v1/system', () => {
    async function get() {
      return app.inject({ method: 'GET', url: '/api/v1/system', headers: keyHeaders });
    }

    it('returns 200 with exactly the five build/version fields', async () => {
      const res = await get();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(
        ['buildTime', 'commit', 'nodeVersion', 'os', 'version'],
      );
    });

    it('never leaks the sensitive /api/system/info fields', async () => {
      const body = (await get()).json();
      expect(body).not.toHaveProperty('libraryPath');
      expect(body).not.toHaveProperty('freeSpace');
      expect(body).not.toHaveProperty('dbSize');
    });

    it('round-trips through the strict systemV1Schema with no extra keys', async () => {
      const body = (await get()).json();
      expect(() => systemV1Schema.parse(body)).not.toThrow();
      expect(Object.keys(body)).toHaveLength(5);
    });

    it('sources field values from the existing version/node/os helpers', async () => {
      const body = (await get()).json();
      expect(body.version).toBe(getVersion());
      expect(body.commit).toBe(getCommit());
      expect(body.buildTime).toBe(getBuildTime());
      expect(body.nodeVersion).toBe(process.version);
      expect(body.os).toBe(`${os.type()} ${os.release()}`);
    });
  });

  describe('auth', () => {
    it('rejects a missing API key with 401 (status only — ambient body, not the v1 envelope)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a presented-but-invalid API key with the 401 v1 envelope (#1472)', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/system', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
      expectV1Envelope(body);
    });
  });

  describe('no collision with the Prowlarr/Readarr compat shim', () => {
    it('leaves GET /api/v1/system/status routing to the compat handler', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/status', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ compat: true });
    });
  });
});

function validSystemBody() {
  return {
    version: 'dev',
    commit: 'unknown',
    buildTime: 'unknown',
    nodeVersion: 'v24.0.0',
    os: 'Linux 6.1.0',
  };
}

// Pin fail-closed behavior at both direct parsing and Fastify serialization.
describe('strict / fail-closed schema (F1)', () => {
  it.each(['libraryPath', 'freeSpace', 'dbSize'])(
    'systemV1Schema.parse rejects the sensitive %s field instead of stripping it',
    (extra) => {
      const result = systemV1Schema.safeParse({ ...validSystemBody(), [extra]: 'leaked' });
      expect(result.success).toBe(false);
    },
  );

  it('Fastify serialization fails closed (500) when a handler leaks an internal field', async () => {
    const leakyApp = Fastify({ logger: false });
    leakyApp.setSerializerCompiler(serializerCompiler);
    leakyApp.get('/leak', { schema: { response: { 200: systemV1Schema } } }, async () => ({
      ...validSystemBody(),
      dbSize: 4096,
    }));
    await leakyApp.ready();

    const res = await leakyApp.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('dbSize');

    await leakyApp.close();
  });
});
