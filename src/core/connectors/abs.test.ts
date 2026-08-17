import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
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
afterEach(() => {
  server.resetHandlers();
  // The #2317 cases spy on globalThis.fetch directly. The spy is installed after
  // server.listen(), so restoring it hands MSW's patched fetch back to the next test.
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function makeConnector(libraryId = 'lib-1') {
  return new AudiobookshelfConnector({ baseUrl: BASE_URL, apiKey: 'secret-key', libraryId });
}

const BATCH: ConnectorImportBatch = {
  reasons: ['import'],
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
        reasons: ['rename'],
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

  // Pinned BEFORE the #2312 extraction so the shared classifier cannot move a verdict
  // silently. Every row below is pre-existing behaviour except the 408/429 block, which is
  // the one declared change.
  describe('status verdicts and presentation (#2312 AC1)', () => {
    async function reject(run: () => Promise<unknown>): Promise<ConnectorRequestError> {
      try {
        await run();
      } catch (error: unknown) {
        return error as ConnectorRequestError;
      }
      throw new Error('expected the call to reject');
    }

    it.each([
      [401, false],
      [403, false],
      [404, false],
      [400, false],
      [500, true],
      [503, true],
    ])('listTargets: HTTP %i → retryable %s', async (status, retryable) => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status })));
      const error = await reject(() => makeConnector().listTargets());
      expect(error.retryable).toBe(retryable);
    });

    it('listTargets: 404 with no notFound field falls through to the generic arm', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 404 })));
      const error = await reject(() => makeConnector().listTargets());
      expect(error.message).toBe('Request failed (HTTP 404)');
      expect(error.fieldErrors).toBeUndefined();
    });

    it('listTargets: 400 keeps its generic message', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 400 })));
      const error = await reject(() => makeConnector().listTargets());
      expect(error.message).toBe('Request failed (HTTP 400)');
      expect(error.fieldErrors).toBeUndefined();
    });

    it('keeps the abs-specific auth presentation (apiKey, not token)', async () => {
      server.use(http.get(LIBRARIES_URL, () => HttpResponse.json({}, { status: 403 })));
      const error = await reject(() => makeConnector().listTargets());
      expect(error.message).toBe('Authentication failed (HTTP 403)');
      expect(error.fieldErrors).toEqual({ apiKey: 'Invalid API key' });
    });

    it('keeps the abs-specific not-found presentation on the libraryId path', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 404 })));
      const error = await reject(() => makeConnector().refreshImport(BATCH, SIGNAL));
      expect(error.message).toBe('Library not found (HTTP 404)');
      expect(error.fieldErrors).toEqual({ libraryId: 'Library not found' });
    });

    it('keeps the server-error message for 5xx', async () => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status: 500 })));
      const error = await reject(() => makeConnector().refreshImport(BATCH, SIGNAL));
      expect(error.message).toBe('Server error (HTTP 500)');
      expect(error.retryable).toBe(true);
    });

    // The one deliberate verdict change: a timeout and a rate-limit are temporary by
    // definition, so the shared classifier corrects the old blanket non-retryable arm.
    it.each([408, 429])('HTTP %i is now retryable (declared change)', async (status) => {
      server.use(http.post(SCAN_URL, () => HttpResponse.json({}, { status })));
      const error = await reject(() => makeConnector().refreshImport(BATCH, SIGNAL));
      expect(error.retryable).toBe(true);
    });
  });

  // Pinned when connectionError moved into the shared connectorConnectionError (#2317). The
  // pre-existing coverage asserts fieldErrors.baseUrl via expect.any(String), which cannot see
  // a reworded field error or a dropped `Connection failed: ` prefix. Both rows stub
  // globalThis.fetch rather than adding an MSW handler: HttpResponse.error() carries no
  // transport code, so it could only ever reach mapNetworkError's pass-through arm.
  describe('connection failure — exact copy and unconditional verdict (#2317 AC10)', () => {
    async function rejectionFrom(run: () => Promise<unknown>): Promise<ConnectorRequestError> {
      try {
        await run();
      } catch (error: unknown) {
        return error as ConnectorRequestError;
      }
      throw new Error('expected the call to reject');
    }

    function rejectFetchWith(message: string, code: string): void {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error(message), { code }));
    }

    it('reports the mapped transport message behind the Connection failed prefix', async () => {
      rejectFetchWith('connect ECONNREFUSED 127.0.0.1:8080', 'ECONNREFUSED');

      const error = await rejectionFrom(() => makeConnector().listTargets());

      expect(error.message).toBe('Connection failed: Connection refused on port 8080');
      expect(error.fieldErrors).toEqual({ baseUrl: 'Could not connect to server' });
      expect(error.retryable).toBe(true);
    });

    // A connector that never reached the server has learned nothing about whether a retry
    // helps, so a terminal transport code must NOT flip the verdict. Routing this path
    // through classifyFailure is the behaviour change #2312 AC1 excluded.
    it('stays retryable for a transport code classifyFailure treats as terminal', async () => {
      rejectFetchWith('authentication rejected', 'EAUTH');

      const error = await rejectionFrom(() => makeConnector().refreshImport(BATCH, SIGNAL));

      expect(error.retryable).toBe(true);
      expect(error.fieldErrors).toEqual({ baseUrl: 'Could not connect to server' });
    });
  });
});
