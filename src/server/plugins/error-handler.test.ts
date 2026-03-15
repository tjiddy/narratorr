import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { errorHandlerPlugin } from './error-handler.js';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { RecyclingBinError } from '../services/recycling-bin.service.js';
import { RestoreUploadError } from '../services/backup.service.js';

function createTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(errorHandlerPlugin);

  // Test routes that throw various errors
  app.get('/throw-rename-not-found', async () => { throw new RenameError('Book not found', 'NOT_FOUND'); });
  app.get('/throw-rename-no-path', async () => { throw new RenameError('No path set', 'NO_PATH'); });
  app.get('/throw-retag-not-found', async () => { throw new RetagError('NOT_FOUND', 'Book not found'); });
  app.get('/throw-retag-ffmpeg', async () => { throw new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg not installed'); });
  app.get('/throw-recycling-not-found', async () => { throw new RecyclingBinError('Entry not found', 'NOT_FOUND'); });
  app.get('/throw-recycling-conflict', async () => { throw new RecyclingBinError('Path conflict', 'CONFLICT'); });
  app.get('/throw-recycling-filesystem', async () => { throw new RecyclingBinError('Disk error', 'FILESYSTEM'); });
  app.get('/throw-restore-invalid', async () => { throw new RestoreUploadError('Not a valid zip', 'INVALID_ZIP'); });
  app.get('/throw-generic', async () => { throw new Error('disk full'); });
  app.get('/throw-non-error', async () => { throw 'string error'; });
  app.get('/success', async () => ({ ok: true }));

  // Route with schema validation for F3
  const bodySchema = z.object({ name: z.string(), age: z.number() });
  app.post('/validated', { schema: { body: bodySchema } }, async (request) => {
    return request.body;
  });

  return app;
}

describe('error-handler plugin', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    app = createTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('typed error mapping', () => {
    it('maps RenameError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-rename-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('maps RenameError NO_PATH to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-rename-no-path' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'No path set' });
    });

    it('maps RetagError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-retag-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('maps RetagError FFMPEG_NOT_CONFIGURED to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-retag-ffmpeg' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'ffmpeg not installed' });
    });

    it('maps RecyclingBinError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-recycling-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Entry not found' });
    });

    it('maps RecyclingBinError CONFLICT to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-recycling-conflict' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Path conflict' });
    });

    it('maps RestoreUploadError to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-restore-invalid' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Not a valid zip' });
    });
  });

  describe('generic error handling', () => {
    it('maps untyped Error to 500 with generic message (no stack leak)', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-generic' });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });

    it('maps non-Error throw to 500 with generic message', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-non-error' });
      expect(res.statusCode).toBe(500);
    });

    it('does not interfere with successful responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/success' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });
  });

  describe('Fastify validation errors (F3)', () => {
    it('returns Fastify-format 400 for schema validation failure', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/validated',
        payload: { name: 123, age: 'not-a-number' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.stringContaining('expected'),
      });
    });

    it('passes valid payload through without error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/validated',
        payload: { name: 'Alice', age: 30 },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ name: 'Alice', age: 30 });
    });
  });
});

describe('error-handler logging (F4)', () => {
  const logSpy = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };

  let app: Awaited<ReturnType<typeof Fastify>>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);

    // Inject spyable logger via hook
    app.addHook('onRequest', async (request: FastifyRequest) => {
      request.log = logSpy as never;
    });

    app.get('/throw-recycling-fs', async () => { throw new RecyclingBinError('Disk error', 'FILESYSTEM'); });
    app.get('/throw-generic-500', async () => { throw new Error('disk full'); });
    app.get('/throw-rename-no-path', async () => { throw new RenameError('No path set', 'NO_PATH'); });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logSpy.error.mockClear();
    logSpy.warn.mockClear();
  });

  it('logs request.log.error for RecyclingBinError FILESYSTEM (typed 500)', async () => {
    await app.inject({ method: 'GET', url: '/throw-recycling-fs' });
    expect(logSpy.error).toHaveBeenCalled();
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it('logs request.log.error for generic untyped Error (500)', async () => {
    await app.inject({ method: 'GET', url: '/throw-generic-500' });
    expect(logSpy.error).toHaveBeenCalled();
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it('logs request.log.warn for typed 4xx errors (RenameError NO_PATH)', async () => {
    await app.inject({ method: 'GET', url: '/throw-rename-no-path' });
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logSpy.error).not.toHaveBeenCalled();
  });
});
