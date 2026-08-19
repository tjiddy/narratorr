import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import { TaskRegistryError } from '../services/task-registry.js';
import type { Services } from './index.js';

const validImportList = {
  name: 'My NYT List',
  type: 'nyt',
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { apiKey: 'test-key', list: 'audio-fiction' },
};

const savedList = {
  id: 1,
  ...validImportList,
  lastRunAt: null,
  nextRunAt: new Date().toISOString(),
  lastSyncError: null,
  createdAt: new Date().toISOString(),
};

describe('import-lists routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let logSpies: ReturnType<typeof installMockAppLog>['spies'];
  let restoreLog: () => void;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
    const installed = installMockAppLog(app);
    logSpies = installed.spies;
    restoreLog = installed.restore;
  });

  afterAll(async () => {
    restoreLog();
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    for (const s of Object.values(logSpies)) s.mockClear();
  });

  describe('GET /api/import-lists', () => {
    it('returns all lists with masked secrets', async () => {
      (services.importList.getAll as Mock).mockResolvedValue([savedList]);

      const res = await app.inject({ method: 'GET', url: '/api/import-lists' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('My NYT List');
      expect(body[0].settings.apiKey).toBe('********');
    });
  });

  describe('GET /api/import-lists/:id', () => {
    it('returns single list with masked secrets', async () => {
      (services.importList.getById as Mock).mockResolvedValue(savedList);

      const res = await app.inject({ method: 'GET', url: '/api/import-lists/1' });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('My NYT List');
      expect(res.json().settings.apiKey).toBe('********');
    });
  });

  describe('POST /api/import-lists', () => {
    it('creates list with encrypted API key and sets nextRunAt', async () => {
      (services.importList.create as Mock).mockResolvedValue(savedList);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: validImportList,
      });

      expect(res.statusCode).toBe(201);
      expect(services.importList.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My NYT List', type: 'nyt' }),
      );
    });

    it('rejects invalid provider type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { ...validImportList, type: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { type: 'nyt', settings: {} },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing provider-specific required settings', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { name: 'Bad NYT', type: 'nyt', settings: { list: 'audio-fiction' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('settings/apiKey');
    });

    it('rejects sync interval below minimum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { ...validImportList, syncIntervalMinutes: 2 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/import-lists/:id', () => {
    it('updates list with sentinel passthrough', async () => {
      (services.importList.update as Mock).mockResolvedValue(savedList);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Updated Name' }));
    });

    it('rejects missing provider-specific required settings on update', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { type: 'nyt', settings: { list: 'audio-fiction' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('settings/apiKey');
    });

    it('returns 400 when settings provided without type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { settings: { apiKey: 'key', list: 'audio-fiction' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('type');
      expect(services.importList.update).not.toHaveBeenCalled();
    });

    it('accepts toggle-only update without type or settings', async () => {
      (services.importList.update as Mock).mockResolvedValue({ ...savedList, enabled: false });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('DELETE /api/import-lists/:id', () => {
    it('removes list', async () => {
      (services.importList.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/import-lists/1' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/import-lists/test', () => {
    it('calls provider test with provided config', async () => {
      (services.importList.testConfig as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/test',
        payload: validImportList,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('accepts sentinel in apiKey with id and forwards to testConfig', async () => {
      (services.importList.testConfig as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/test',
        payload: {
          name: 'nyt-edit',
          type: 'nyt',
          enabled: true,
          syncIntervalMinutes: 1440,
          settings: { apiKey: '********', list: 'audio-fiction' },
          id: 11,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.testConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 11 }),
      );
    });
  });

  describe('POST /api/import-lists/:id/test', () => {
    it('calls provider test with saved config', async () => {
      (services.importList.test as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/1/test' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/import-lists/:id/run (#2306)', () => {
    /** The guard is the route's, not the test's: admit by default and let each case override. */
    const admit = () => (services.taskRegistry.runExclusive as Mock).mockImplementation(
      async (_name: string, fn: () => Promise<unknown>) => fn(),
    );

    it('returns the counts of a completed sync', async () => {
      admit();
      (services.importList.runNow as Mock).mockResolvedValue({
        status: 'ok',
        counts: { createdCount: 3, heldReviewCount: 1, excludedCount: 2 },
      });

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/1/run' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, createdCount: 3, heldReviewCount: 1, excludedCount: 2 });
      expect(services.importList.runNow).toHaveBeenCalledWith(1);
    });

    it('reports a sync that threw as a non-success body', async () => {
      admit();
      (services.importList.runNow as Mock).mockResolvedValue({ status: 'failed', message: 'Connection timeout' });

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/2/run' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false, message: 'Connection timeout' });
    });

    it('returns 404 for an unknown list id', async () => {
      admit();
      (services.importList.runNow as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/999/run' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Import list not found' });
    });

    it('returns 409 when the import-list-sync task is already running (plugin-routed)', async () => {
      (services.taskRegistry.runExclusive as Mock).mockRejectedValue(
        new TaskRegistryError('Task "import-list-sync" is already running', 'ALREADY_RUNNING'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/1/run' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Task "import-list-sync" is already running' });
      expect(services.importList.runNow).not.toHaveBeenCalled();
    });

    it('surfaces a non-TaskRegistryError rejection as a 500 — the route adds no swallowing catch', async () => {
      (services.taskRegistry.runExclusive as Mock).mockRejectedValue(new Error('Registry exploded'));

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/1/run' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });

    it('names the import-list-sync task and drives the service from inside the guard', async () => {
      admit();
      (services.importList.runNow as Mock).mockResolvedValue({
        status: 'ok',
        counts: { createdCount: 0, heldReviewCount: 0, excludedCount: 0 },
      });

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/7/run' });

      expect(res.statusCode).toBe(200);
      expect(services.taskRegistry.runExclusive).toHaveBeenCalledWith('import-list-sync', expect.any(Function));
      expect(services.importList.runNow).toHaveBeenCalledWith(7);
    });

    it('rejects a non-numeric id with 400 and never reaches the service', async () => {
      admit();

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/abc/run' });

      expect(res.statusCode).toBe(400);
      expect(services.importList.runNow).not.toHaveBeenCalled();
      expect(services.taskRegistry.runExclusive).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/import-lists/abs/libraries (removed)', () => {
    it('returns 404 — the ABS import-list provider was removed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/import-lists/preview', () => {
    it('accepts config in body and returns first 10 items', async () => {
      const previewResult = {
        items: [{ title: 'Book 1', author: 'Author 1' }],
        total: 1,
      };
      (services.importList.preview as Mock).mockResolvedValue(previewResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: validImportList.type, settings: validImportList.settings },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(previewResult);
    });

    it('returns empty items array when provider returns nothing', async () => {
      (services.importList.preview as Mock).mockResolvedValue({ items: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: validImportList.type, settings: validImportList.settings },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], total: 0 });
    });

    it('returns 500 with error message and logs canonical serialized error when preview service rejects', async () => {
      (services.importList.preview as Mock).mockRejectedValue(new Error('Preview exploded'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: validImportList.type, settings: validImportList.settings },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Preview exploded');
      expect(logSpies.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'Preview exploded', type: 'Error' }) }),
        'Import list preview failed',
      );
    });

    it('returns 400 for invalid typed settings and does not call service.preview', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: 'nyt', settings: { list: 'audio-fiction' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('settings/apiKey');
      expect(services.importList.preview).not.toHaveBeenCalled();
    });


    it('resolves sentinel apiKey against persisted list and dispatches plaintext (nyt)', async () => {
      (services.importList.getById as Mock).mockResolvedValue({
        ...savedList,
        settings: { apiKey: 'real-nyt-key', list: 'audio-fiction' },
      });
      (services.importList.preview as Mock).mockResolvedValue({ items: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.preview).toHaveBeenCalledWith({
        type: 'nyt',
        settings: expect.objectContaining({ apiKey: 'real-nyt-key' }),
      });
    });

    it('returns 400 when sentinel apiKey is sent without id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('id is required');
      expect(services.importList.preview).not.toHaveBeenCalled();
    });

    it('returns 404 when sentinel apiKey + id but list not found', async () => {
      (services.importList.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
          id: 999,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Import list not found');
      expect(services.importList.preview).not.toHaveBeenCalled();
    });

    it('plaintext apiKey bypasses resolution and dispatches unchanged (no id required)', async () => {
      (services.importList.preview as Mock).mockResolvedValue({ items: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'nyt',
          settings: { apiKey: 'plaintext-key', list: 'audio-fiction' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.preview).toHaveBeenCalledWith({
        type: 'nyt',
        settings: expect.objectContaining({ apiKey: 'plaintext-key' }),
      });
      expect(services.importList.getById).not.toHaveBeenCalled();
    });

    it('returns 400 for sentinel on non-secret field (settings.list)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'nyt',
          settings: { list: '********', apiKey: 'real' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('non-secret field: list');
      expect(services.importList.preview).not.toHaveBeenCalled();
    });

    it('preserves per-type refinement after schema loosening (hardcover listType=shelf without shelfId → 400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'hardcover',
          settings: { apiKey: '********', listType: 'shelf' },
          id: 2,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(services.importList.preview).not.toHaveBeenCalled();
    });
  });
});
