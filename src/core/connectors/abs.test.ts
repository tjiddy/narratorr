import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { AudiobookshelfConnector } from './abs.js';
import { ConnectorRequestError } from './errors.js';
import type { ConnectorImportBatch } from './types.js';

const BASE_URL = 'http://abs.test:13378';
const LIBRARIES_URL = `${BASE_URL}/api/libraries`;
const SCAN_URL = `${BASE_URL}/api/libraries/lib-1/scan`;

const LIBRARIES_BODY = {
  libraries: [
    { id: 'lib-1', name: 'Audiobooks' },
    { id: 'lib-2', name: 'Podcasts' },
  ],
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConnector(libraryId = 'lib-1') {
  return new AudiobookshelfConnector({ baseUrl: BASE_URL, apiKey: 'secret-key', libraryId });
}

const BATCH: ConnectorImportBatch = {
  reason: 'import',
  items: [{ bookId: 1, title: 'Dune', libraryPath: '/lib/Dune' }],
};

const SIGNAL = new AbortController().signal;

describe('AudiobookshelfConnector', () => {
  describe('test()', () => {
    it('returns { success: true } and sends a Bearer token', async () => {
      let authHeader: string | null = null;
      server.use(http.get(LIBRARIES_URL, ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json(LIBRARIES_BODY);
      }));

      const result = await makeConnector().test();

      expect(result.success).toBe(true);
      expect(authHeader).toBe('Bearer secret-key');
    });

    it('returns fieldErrors.apiKey on 401 without throwing', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 401 })));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.apiKey).toBeDefined();
    });

    it('returns fieldErrors.apiKey on 403', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 403 })));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.apiKey).toBeDefined();
    });

    it('returns fieldErrors.baseUrl on connection failure', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.error()));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.baseUrl).toBeDefined();
    });

    it('returns fieldErrors.libraryId when the configured library is absent', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json(LIBRARIES_BODY)));
      const result = await makeConnector('does-not-exist').test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.libraryId).toBeDefined();
    });
  });

  describe('listTargets()', () => {
    it('maps the /api/libraries response into ConnectorTarget[]', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json(LIBRARIES_BODY)));
      const targets = await makeConnector().listTargets();
      expect(targets).toEqual([
        { id: 'lib-1', name: 'Audiobooks' },
        { id: 'lib-2', name: 'Podcasts' },
      ]);
    });

    it('throws ConnectorRequestError(retryable:false, apiKey) on 401', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 401 })));
      await expect(makeConnector().listTargets()).rejects.toMatchObject({
        retryable: false,
        fieldErrors: { apiKey: expect.any(String) },
      });
      await expect(makeConnector().listTargets()).rejects.toBeInstanceOf(ConnectorRequestError);
    });

    it('throws ConnectorRequestError(retryable:true, baseUrl) on connection failure', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.error()));
      await expect(makeConnector().listTargets()).rejects.toMatchObject({
        retryable: true,
        fieldErrors: { baseUrl: expect.any(String) },
      });
    });
  });

  describe('refreshImport()', () => {
    it('POSTs /api/libraries/{id}/scan with an empty-object body', async () => {
      let body: unknown;
      server.use(http.post(SCAN_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }));

      const result = await makeConnector().refreshImport(BATCH, SIGNAL);

      expect(result).toEqual({ success: true });
      expect(body).toEqual({});
    });

    it('ignores item paths regardless of batch contents', async () => {
      let count = 0;
      server.use(http.post(SCAN_URL, () => { count++; return HttpResponse.json({}); }));

      const batch: ConnectorImportBatch = {
        reason: 'rename',
        items: [
          { bookId: 1, title: 'A', libraryPath: '/x/a', serverPath: '/srv/a' },
          { bookId: 2, title: 'B', libraryPath: '/x/b' },
        ],
      };
      const result = await makeConnector().refreshImport(batch, SIGNAL);
      expect(result.success).toBe(true);
      expect(count).toBe(1);
    });

    it('issues exactly one HTTP request per call, even on failure', async () => {
      let count = 0;
      server.use(http.post(SCAN_URL, () => { count++; return HttpResponse.json({}, { status: 500 }); }));

      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).rejects.toBeInstanceOf(ConnectorRequestError);
      expect(count).toBe(1);
    });

    it('estimateRequestCount is always 1 — single-request adapter, batch-independent (#1506 AC3)', () => {
      // ABS issues one full library scan per call regardless of how many items the
      // batch carries, so its scaled flush-timeout budget never grows.
      expect(makeConnector().estimateRequestCount()).toBe(1);
    });

    it('classifies 401 as retryable:false with apiKey field error', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 401 })));
      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).rejects.toMatchObject({
        retryable: false,
        fieldErrors: { apiKey: expect.any(String) },
      });
    });

    it('classifies 404 as retryable:false with libraryId field error', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 404 })));
      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).rejects.toMatchObject({
        retryable: false,
        fieldErrors: { libraryId: expect.any(String) },
      });
    });

    it('classifies 5xx as retryable:true', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 503 })));
      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).rejects.toMatchObject({ retryable: true });
    });

    it('classifies connection failure as retryable:true with baseUrl field error', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.error()));
      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).rejects.toMatchObject({
        retryable: true,
        fieldErrors: { baseUrl: expect.any(String) },
      });
    });

    it('resolves { success: true } on 2xx', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 200 })));
      await expect(makeConnector().refreshImport(BATCH, SIGNAL)).resolves.toEqual({ success: true });
    });
  });
});
