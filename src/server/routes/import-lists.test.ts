import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../../core/utils/constants.js';
import type { Services } from './index.js';

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
    // A single afterEach restores the fetch spy — a tail-of-body `vi.restoreAllMocks()`
    // never runs when an assertion throws mid-test, leaking the `*Once`-queued spy onto
    // the next test (cascade against real `http://abs.local`). #1335.
    afterEach(() => vi.restoreAllMocks());

    it('returns libraries from ABS API (preserves passthrough extras at both levels)', async () => {
      // Realistic ABS envelope: element-level extras (folders/mediaType/settings) AND a
      // top-level unknown key. The shared schema is `.passthrough()` at BOTH the inner
      // library object (abs-provider.ts:39) and the top-level response (abs-provider.ts:40);
      // tightening either to `.strict()` would 502 every real ABS server (#1198 bug class).
      // This pins acceptance of that envelope. The route returns the parsed libraries
      // verbatim, so we assert the expected id/name are present — NOT that extras are dropped.
      const mockLibraries = [
        {
          id: 'lib-1',
          name: 'Audiobooks',
          folders: [{ id: 'f1', fullPath: '/data/audiobooks' }],
          mediaType: 'book',
          settings: { coverAspectRatio: 1 },
        },
        { id: 'lib-2', name: 'Podcasts', mediaType: 'podcast' },
      ];
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: mockLibraries, someTopLevelExtra: true }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      const returned = res.json().libraries as Array<Record<string, unknown>>;
      expect(returned).toContainEqual(expect.objectContaining({ id: 'lib-1', name: 'Audiobooks' }));
      expect(returned).toContainEqual(expect.objectContaining({ id: 'lib-2', name: 'Podcasts' }));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://abs.local/api/libraries',
        expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
      );
    });

    // #1299 — validate ABS response with the shared schema, not a bare cast
    it('returns 502 for a wrong-shape HTTP 200 response (ABS error object)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'unauthorized' }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('unexpected response');
    });

    it('returns 502 when libraries is not an array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: 'nope' }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      // Distinguishes the schema-validation 502 from the transport catch-all 502 —
      // a status-only assertion can't tell them apart, so rerouting validation
      // through the catch-all (`Connection failed:`) would still pass. #1335.
      expect(res.json().error).toContain('unexpected response');
    });

    it('returns 502 when the libraries key is missing (not a silent empty list)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      // Same message-routing pin as the not-an-array case: schema 502, not catch-all. #1335.
      expect(res.json().error).toContain('unexpected response');
    });

    // #1335 — boundary pins for the malformed/edge `libraries` shapes.
    it('returns 200 with an empty list when libraries is an empty array', async () => {
      // Intent-named pin: `{ libraries: [] }` is a valid (if empty) ABS response, not an
      // error. A future `.min(1)` on the libraries array would 502 here and fail loudly
      // rather than relying on the incidental #844 sentinel-resolution coverage.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: [] }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().libraries).toEqual([]);
    });

    it('returns 502 when libraries is null (distinct from missing key)', async () => {
      // The schema field is a plain `z.array(...)` with no `.optional()`/`.nullish()`, so
      // `null` is a distinct schema-validation 502 path per the documented Zod gotcha.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: null }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('unexpected response');
    });

    it('returns 502 for a malformed array element (null name), with dotted path prefix + warn log', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: [{ id: 'lib', name: null }] }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      // Nested failure surfaces the dotted Zod path so operators see WHERE it broke.
      expect(res.json().error).toMatch(/^ABS API returned an unexpected response: libraries\.0\.name:/);
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://abs.local/', error: expect.anything() }),
        'ABS library fetch failed schema validation',
      );
    });

    it('returns 502 with no leading ": " artifact for a top-level (empty-path) shape failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      const { error } = res.json();
      expect(error).toContain('ABS API returned an unexpected response: ');
      // Empty Zod path must not produce `...response: : <msg>`.
      expect(error).not.toContain('response: :');
    });

    it('returns the static non-JSON 502 message + warn log when res.json() throws (proxy interstitial)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError("Unexpected token '<'"); },
      } as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      const { error } = res.json();
      expect(error).toBe('ABS returned a non-JSON response (check reverse-proxy/auth configuration)');
      // The SyntaxError must NOT leak through as the old generic transport diagnosis.
      expect(error).not.toContain('Connection failed');
      expect(error).not.toContain('Unexpected token');
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://abs.local/', error: expect.anything() }),
        'ABS library fetch returned non-JSON body',
      );
    });

    it('returns 502 (no hang) when the fetch times out, bounded by IMPORT_LIST_TIMEOUT_MS', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new DOMException('The operation timed out', 'TimeoutError'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('Connection failed');
      // Pins the shared const, not just the catch-branch behavior.
      expect(timeoutSpy).toHaveBeenCalledWith(IMPORT_LIST_TIMEOUT_MS);
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://abs.local/', error: expect.anything() }),
        'ABS library fetch failed (transport)',
      );
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'bad-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('ABS API returned 401');
      // Non-OK branch synthesizes a serialized cause + carries the numeric status.
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://abs.local/', status: 401, error: expect.anything() }),
        'ABS library fetch failed (non-OK status)',
      );
    });

    it('sanitizes the logged URL and never logs the apiKey across log branches', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'https://user:pass@abs.example/?token=abc', apiKey: 'super-secret-key' },
      });

      expect(res.statusCode).toBe(502);
      const warnArg = (logSpies.warn.mock.calls.at(-1)?.[0] ?? {}) as { url?: string };
      // Userinfo + query token stripped to origin + pathname.
      expect(warnArg.url).toBe('https://abs.example/');
      expect(warnArg.url).not.toContain('user:pass');
      expect(warnArg.url).not.toContain('token=abc');
      // The apiKey lives only in the Authorization header — never in any log line.
      const allLogged = JSON.stringify(logSpies.warn.mock.calls);
      expect(allLogged).not.toContain('super-secret-key');
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
    });

    // ===== #844 — sentinel resolution =====

    it('resolves sentinel apiKey against persisted list and forwards plaintext to ABS', async () => {
      (services.importList.getById as Mock).mockResolvedValue({
        ...savedList,
        settings: { serverUrl: 'http://abs.local', apiKey: 'real-abs-key', libraryId: 'lib-1' },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: [] }),
      } as Response);

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
