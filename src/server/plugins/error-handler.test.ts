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
import { RestoreUploadError } from '../services/backup.service.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';
import { EventHistoryServiceError } from '../services/event-history.service.js';
import { MergeError } from '../services/merge.service.js';
import { DownloadError, DuplicateDownloadError } from '../services/download.service.js';
import { TaskRegistryError } from '../services/task-registry.js';

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
  app.get('/throw-restore-invalid', async () => { throw new RestoreUploadError('Not a valid zip', 'INVALID_ZIP'); });
  app.get('/throw-qg-not-found', async () => { throw new QualityGateServiceError('Download not found', 'NOT_FOUND'); });
  app.get('/throw-qg-invalid-status', async () => { throw new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS'); });
  app.get('/throw-eh-not-found', async () => { throw new EventHistoryServiceError('Event not found', 'NOT_FOUND'); });
  app.get('/throw-eh-unsupported', async () => { throw new EventHistoryServiceError('Event type does not support mark-as-failed', 'UNSUPPORTED_EVENT_TYPE'); });
  app.get('/throw-eh-no-download', async () => { throw new EventHistoryServiceError('Event has no associated download', 'NO_DOWNLOAD'); });
  app.get('/throw-eh-download-not-found', async () => { throw new EventHistoryServiceError('Associated download not found', 'DOWNLOAD_NOT_FOUND'); });
  app.get('/throw-merge-not-found', async () => { throw new MergeError('Book not found', 'NOT_FOUND'); });
  app.get('/throw-merge-no-path', async () => { throw new MergeError('Book has no path', 'NO_PATH'); });
  app.get('/throw-merge-no-status', async () => { throw new MergeError('Not imported', 'NO_STATUS'); });
  app.get('/throw-merge-no-files', async () => { throw new MergeError('No audio files', 'NO_TOP_LEVEL_FILES'); });
  app.get('/throw-merge-no-ffmpeg', async () => { throw new MergeError('ffmpeg not configured', 'FFMPEG_NOT_CONFIGURED'); });
  app.get('/throw-merge-in-progress', async () => { throw new MergeError('Already in progress', 'ALREADY_IN_PROGRESS'); });
  app.get('/throw-download-not-found', async () => { throw new DownloadError('Download 1 not found', 'NOT_FOUND'); });
  app.get('/throw-download-no-book', async () => { throw new DownloadError('Download 1 has no book linked', 'NO_BOOK_LINKED'); });
  app.get('/throw-download-invalid-status', async () => { throw new DownloadError('Download 1 is not in failed state', 'INVALID_STATUS'); });
  app.get('/throw-task-not-found', async () => { throw new TaskRegistryError('Task "foo" not found', 'NOT_FOUND'); });
  app.get('/throw-task-already-running', async () => { throw new TaskRegistryError('Task "foo" is already running', 'ALREADY_RUNNING'); });
  app.get('/throw-duplicate-active', async () => { throw new DuplicateDownloadError('Book 1 already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'); });
  app.get('/throw-duplicate-pipeline', async () => { throw new DuplicateDownloadError('Book 1 has pipeline download', 'PIPELINE_ACTIVE'); });
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

    it('maps RestoreUploadError to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-restore-invalid' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Not a valid zip' });
    });

    it('maps QualityGateServiceError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-qg-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download not found' });
    });

    it('maps QualityGateServiceError INVALID_STATUS to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-qg-invalid-status' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download is not pending review' });
    });

    it('maps EventHistoryServiceError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-eh-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Event not found' });
    });

    it('maps EventHistoryServiceError UNSUPPORTED_EVENT_TYPE to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-eh-unsupported' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Event type does not support mark-as-failed' });
    });

    it('maps EventHistoryServiceError NO_DOWNLOAD to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-eh-no-download' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Event has no associated download' });
    });

    it('maps EventHistoryServiceError DOWNLOAD_NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-eh-download-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Associated download not found' });
    });

    it('maps MergeError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('maps MergeError NO_PATH to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-no-path' });
      expect(res.statusCode).toBe(400);
    });

    it('maps MergeError NO_STATUS to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-no-status' });
      expect(res.statusCode).toBe(400);
    });

    it('maps MergeError NO_TOP_LEVEL_FILES to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-no-files' });
      expect(res.statusCode).toBe(400);
    });

    it('maps MergeError FFMPEG_NOT_CONFIGURED to 503', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-no-ffmpeg' });
      expect(res.statusCode).toBe(503);
    });

    it('maps MergeError ALREADY_IN_PROGRESS to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-merge-in-progress' });
      expect(res.statusCode).toBe(409);
    });

    // #149 — DownloadError and TaskRegistryError typed error mapping (ERR-1)
    it('maps DownloadError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-download-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 1 not found' });
    });

    it('maps DownloadError NO_BOOK_LINKED to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-download-no-book' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 1 has no book linked' });
    });

    it('maps DownloadError INVALID_STATUS to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-download-invalid-status' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 1 is not in failed state' });
    });

    it('maps TaskRegistryError NOT_FOUND to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-task-not-found' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Task "foo" not found' });
    });

    it('maps TaskRegistryError ALREADY_RUNNING to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-task-already-running' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Task "foo" is already running' });
    });

    // #197 — DuplicateDownloadError typed error mapping (ERR-1)
    it('maps DuplicateDownloadError ACTIVE_DOWNLOAD_EXISTS to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-duplicate-active' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book 1 already has an active download' });
    });

    it('maps DuplicateDownloadError PIPELINE_ACTIVE to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw-duplicate-pipeline' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book 1 has pipeline download' });
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
