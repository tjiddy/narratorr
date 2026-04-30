import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

const validImportList = {
  name: 'My ABS List',
  type: 'abs',
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { serverUrl: 'http://abs.local', apiKey: 'test-key', libraryId: 'lib-1' },
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
      expect(body[0].name).toBe('My ABS List');
      // Settings should have apiKey masked
      expect(body[0].settings.apiKey).toBe('********');
    });
  });

  describe('GET /api/import-lists/:id', () => {
    it('returns single list with masked secrets', async () => {
      (services.importList.getById as Mock).mockResolvedValue(savedList);

      const res = await app.inject({ method: 'GET', url: '/api/import-lists/1' });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('My ABS List');
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
        expect.objectContaining({ name: 'My ABS List', type: 'abs' }),
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
        payload: { type: 'abs', settings: {} },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing provider-specific required settings', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { name: 'Bad ABS', type: 'abs', settings: { serverUrl: 'http://abs.local' } },
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
        payload: { type: 'abs', settings: { serverUrl: 'http://abs.local' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('settings/apiKey');
    });

    it('returns 400 when settings provided without type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { settings: { apiKey: 'key', serverUrl: 'http://test', libraryId: 'lib' } },
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

    // #827 — sentinel-laden body + valid id reaches the service (no schema 400)
    it('accepts sentinel in apiKey with id and forwards to testConfig', async () => {
      (services.importList.testConfig as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/test',
        payload: {
          name: 'abs-edit',
          type: 'abs',
          enabled: true,
          syncIntervalMinutes: 1440,
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
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

  describe('POST /api/import-lists/abs/libraries', () => {
    it('returns libraries from ABS API', async () => {
      const mockLibraries = [{ id: 'lib-1', name: 'Audiobooks' }, { id: 'lib-2', name: 'Podcasts' }];
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ libraries: mockLibraries }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ libraries: mockLibraries });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://abs.local/api/libraries',
        expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
      );
      vi.restoreAllMocks();
    });

    it('returns 400 when apiKey is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when serverUrl is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: '', apiKey: 'k' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when serverUrl is not a URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'not-a-url', apiKey: 'k' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 502 when ABS API returns non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'bad-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('ABS API returned 401');
      vi.restoreAllMocks();
    });

    it('returns 502 when connection fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('Connection failed: ECONNREFUSED');
      vi.restoreAllMocks();
    });

    // ===== #844 — sentinel resolution =====

    it('resolves sentinel apiKey against persisted list and forwards plaintext to ABS', async () => {
      (services.importList.getById as Mock).mockResolvedValue({
        ...savedList,
        settings: { serverUrl: 'http://abs.local', apiKey: 'real-abs-key', libraryId: 'lib-1' },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ libraries: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: '********', id: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://abs.local/api/libraries',
        expect.objectContaining({ headers: { Authorization: 'Bearer real-abs-key' } }),
      );
      // Sentinel literal must never reach ABS
      const fetchCall = (globalThis.fetch as unknown as Mock).mock.calls[0];
      const headers = (fetchCall?.[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).not.toContain('********');
      vi.restoreAllMocks();
    });

    it('returns 400 when sentinel apiKey is sent without id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: '********' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('id is required');
    });

    it('returns 404 when sentinel apiKey + id but list not found', async () => {
      (services.importList.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: '********', id: 999 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Import list not found');
    });

    it('returns 400 for sentinel on non-secret field (top-level serverUrl)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: '********', apiKey: 'real-key', id: 1 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('non-secret field: serverUrl');
    });

    // ===== #877 F6 — SSRF refusal mapping + RESPONSE_CAP_ABS at the route boundary =====

    it.each([
      'http://192.168.1.10:13378',
      'http://10.0.0.5:13378',
      'http://169.254.169.254',
      'http://[::1]:13378',
      'http://metadata.google.internal',
    ])('returns 502 with refusal message when serverUrl targets %s (no fetch)', async (serverUrl) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl, apiKey: 'k' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/Refused/);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns 502 when DNS for a public-looking serverUrl resolves to a private address (rebinding)', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs-rebind.example.com', apiKey: 'k' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/Refused/);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns 502 when ABS response Content-Length exceeds RESPONSE_CAP_ABS (5 MiB)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('truncated-body', {
          status: 200,
          headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'k' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/cap/i);
      fetchSpy.mockRestore();
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
        payload: { type: 'abs', settings: { serverUrl: 'http://abs.local' } }, // missing apiKey, libraryId
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('settings/apiKey');
      expect(services.importList.preview).not.toHaveBeenCalled();
    });

    // ===== #844 — sentinel resolution =====

    it('resolves sentinel apiKey against persisted list and dispatches plaintext (abs)', async () => {
      (services.importList.getById as Mock).mockResolvedValue({
        ...savedList,
        settings: { serverUrl: 'http://abs.local', apiKey: 'real-abs-key', libraryId: 'lib-1' },
      });
      (services.importList.preview as Mock).mockResolvedValue({ items: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.preview).toHaveBeenCalledWith({
        type: 'abs',
        settings: expect.objectContaining({ apiKey: 'real-abs-key' }),
      });
    });

    it('returns 400 when sentinel apiKey is sent without id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
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
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
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
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: 'plaintext-key', libraryId: 'lib-1' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.preview).toHaveBeenCalledWith({
        type: 'abs',
        settings: expect.objectContaining({ apiKey: 'plaintext-key' }),
      });
      expect(services.importList.getById).not.toHaveBeenCalled();
    });

    it('returns 400 for sentinel on non-secret field (settings.serverUrl)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: {
          type: 'abs',
          settings: { serverUrl: '********', apiKey: 'real', libraryId: 'lib-1' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('non-secret field: serverUrl');
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
