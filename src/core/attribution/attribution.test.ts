import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { analyzeAttribution } from './attribution.js';
import {
  EARWITNESS_ATTRIBUTION_MAX_RETRIES,
  EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS,
  EARWITNESS_ATTRIBUTION_MAX_BACKOFF_MS,
} from '../utils/constants.js';

const BASE_URL = 'https://earwitness.test';
const API_KEY = 'ew-secret-key';
const ATTR_URL = `${BASE_URL}/api/v1/attribution`;

function detectionOnlyBody() {
  return {
    requestId: 'req-detect',
    detection: {
      attributionPresent: true,
      detected: { title: 'The Way of Kings', authors: ['Brandon Sanderson'], narrators: ['Kate Reading'] },
      evidence: { title: 'Macmillan Audio presents…', author: 'written by Brandon Sanderson', narrator: 'narrated by Kate Reading' },
      confidence: 0.91,
    },
  };
}

function detectionPlusComparisonBody() {
  return {
    requestId: 'req-cmp',
    detection: {
      attributionPresent: true,
      detected: { title: 'The Way of Kings', authors: ['Brandon Sanderson'], narrators: ['Kate Reading'] },
      evidence: { title: null, author: 'written by Brandon Sanderson', narrator: null },
      confidence: 0.42,
    },
    comparison: {
      status: 'partial',
      fields: {
        title: { status: 'match', expected: 'The Way of Kings', detected: 'The Way of Kings', reason: 'exact' },
        authors: {
          status: 'match',
          expected: ['Brandon Sanderson'],
          detected: ['Brandon Sanderson'],
          matched: [{ expected: 'Brandon Sanderson', detected: 'Brandon Sanderson' }],
          missingExpected: [],
          unexpectedDetected: [],
          reason: 'all matched',
        },
        narrators: {
          status: 'partial',
          expected: ['Kate Reading', 'Michael Kramer'],
          detected: ['Kate Reading', 'Stranger McGee'],
          matched: [{ expected: 'Kate Reading', detected: 'Kate Reading' }],
          missingExpected: ['Michael Kramer'],
          unexpectedDetected: ['Stranger McGee'],
          reason: 'one missing, one extra',
        },
      },
    },
  };
}

describe('analyzeAttribution', () => {
  const server = useMswServer();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('adapter surface / wiring', () => {
    it('POSTs to {baseUrl}/api/v1/attribution with X-Api-Key and only path in the body', async () => {
      let capturedUrl = '';
      let capturedKey: string | null = null;
      let capturedBody: unknown;
      server.use(
        http.post(ATTR_URL, async ({ request }) => {
          capturedUrl = request.url;
          capturedKey = request.headers.get('X-Api-Key');
          capturedBody = await request.json();
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'Author/Book' });

      expect(result.kind).toBe('ok');
      expect(capturedUrl).toBe(ATTR_URL);
      expect(capturedKey).toBe(API_KEY);
      expect(capturedBody).toEqual({ path: 'Author/Book' });
      // baseUrl / apiKey / timeoutMs must never leak into the request body.
      expect(capturedBody).not.toHaveProperty('baseUrl');
      expect(capturedBody).not.toHaveProperty('apiKey');
      expect(capturedBody).not.toHaveProperty('timeoutMs');
    });

    it('strips a trailing slash on baseUrl (no double slash)', async () => {
      let capturedUrl = '';
      server.use(
        http.post(ATTR_URL, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      await analyzeAttribution({ baseUrl: `${BASE_URL}/`, apiKey: API_KEY, path: 'x' });
      expect(capturedUrl).toBe(ATTR_URL);
    });

    it('keeps a pathful baseUrl prefix (string join, not new URL(path, base))', async () => {
      const pathfulBase = `${BASE_URL}/earwitness`;
      let capturedUrl = '';
      server.use(
        http.post(`${pathfulBase}/api/v1/attribution`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      await analyzeAttribution({ baseUrl: `${pathfulBase}/`, apiKey: API_KEY, path: 'x' });
      expect(capturedUrl).toBe(`${pathfulBase}/api/v1/attribution`);
    });
  });

  describe('200 parsing', () => {
    it('detection-only: omits expected/requestId in the body, returns detection without comparison', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(ATTR_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(capturedBody).not.toHaveProperty('expected');
      expect(capturedBody).not.toHaveProperty('requestId');
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.requestId).toBe('req-detect');
      expect(result.detection.attributionPresent).toBe(true);
      expect(result.detection.confidence).toBe(0.91);
      expect(result.comparison).toBeUndefined();
    });

    it('detection + comparison: round-trips the MultiFieldComparison breakdown arrays, confidence raw', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(ATTR_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(detectionPlusComparisonBody());
        }),
      );

      const result = await analyzeAttribution({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        path: 'x',
        expected: { title: 'The Way of Kings', authors: ['Brandon Sanderson'], narrators: ['Kate Reading', 'Michael Kramer'] },
        requestId: 'caller-req',
      });

      expect(capturedBody.expected).toEqual({
        title: 'The Way of Kings',
        authors: ['Brandon Sanderson'],
        narrators: ['Kate Reading', 'Michael Kramer'],
      });
      expect(capturedBody.requestId).toBe('caller-req');

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.detection.confidence).toBe(0.42); // raw, not thresholded
      expect(result.comparison).toBeDefined();
      expect(result.comparison!.status).toBe('partial');
      const narrators = result.comparison!.fields.narrators;
      expect(narrators.matched).toEqual([{ expected: 'Kate Reading', detected: 'Kate Reading' }]);
      expect(narrators.missingExpected).toEqual(['Michael Kramer']);
      expect(narrators.unexpectedDetected).toEqual(['Stranger McGee']);
    });

    it('attributionPresent:false on 200 is a valid ok result, not a failure', async () => {
      server.use(
        http.post(ATTR_URL, () =>
          HttpResponse.json({
            requestId: null,
            detection: {
              attributionPresent: false,
              detected: { title: null, authors: [], narrators: [] },
              evidence: { title: null, author: null, narrator: null },
              confidence: 0,
            },
          }),
        ),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.requestId).toBeNull();
      expect(result.detection.attributionPresent).toBe(false);
      expect(result.detection.detected.title).toBeNull();
    });

    it('accepts null on nullable provider fields', async () => {
      const body = detectionOnlyBody();
      body.detection.detected.title = null as unknown as string;
      body.detection.evidence.title = null as unknown as string;
      body.requestId = null as unknown as string;
      server.use(http.post(ATTR_URL, () => HttpResponse.json(body)));

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('ok');
    });

    it('rejects a malformed 200 payload with a typed failure (no unhandled throw)', async () => {
      server.use(
        http.post(ATTR_URL, () =>
          HttpResponse.json({
            requestId: 'r',
            detection: { attributionPresent: 'yes', detected: {}, evidence: {}, confidence: 'high' },
          }),
        ),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
      if (result.kind !== 'permanent_failure') throw new Error('expected permanent_failure');
      expect(result.status).toBe(200);
    });

    it('rejects invalid JSON on a 200 with a typed failure', async () => {
      server.use(http.post(ATTR_URL, () => new HttpResponse('not json', { status: 200 })));

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
    });
  });

  describe('permanent failures (status-only, message surfaced not parsed)', () => {
    it('422 unprocessable-audio → permanent_failure carrying the message, zero retries', async () => {
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          return HttpResponse.json({ error: 'unprocessable audio: corrupt or truncated' }, { status: 422 });
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
      if (result.kind !== 'permanent_failure') throw new Error('expected permanent_failure');
      expect(result.status).toBe(422);
      expect(result.message).toBe('unprocessable audio: corrupt or truncated');
      expect(hits).toBe(1);
    });

    it('422 folder-ambiguity → same permanent branch (status-only, message not parsed)', async () => {
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          return HttpResponse.json({ error: 'path is a folder with 3 distinct books detected' }, { status: 422 });
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
      if (result.kind !== 'permanent_failure') throw new Error('expected permanent_failure');
      expect(result.message).toBe('path is a folder with 3 distinct books detected');
      expect(hits).toBe(1);
    });

    it.each([400, 401, 403, 404])('%d → permanent_failure surfacing the flat error string, no retry', async (status) => {
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          return HttpResponse.json({ error: `boom ${status}` }, { status });
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
      if (result.kind !== 'permanent_failure') throw new Error('expected permanent_failure');
      expect(result.status).toBe(status);
      expect(result.message).toBe(`boom ${status}`);
      expect(hits).toBe(1);
    });

    it('falls back to a status-based message when the error body is missing/unparseable', async () => {
      server.use(http.post(ATTR_URL, () => new HttpResponse('', { status: 400 })));

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });
      expect(result.kind).toBe('permanent_failure');
      if (result.kind !== 'permanent_failure') throw new Error('expected permanent_failure');
      expect(result.message).toContain('400');
    });
  });

  describe('503 transient handling (deterministic bounded retry)', () => {
    // Redirect the adapter's sleep timer to fire immediately while capturing the
    // requested delay. AbortSignal.timeout uses a native timer (not globalThis
    // .setTimeout), so the per-call timeout is unaffected by this spy.
    function captureBackoffDelays(): number[] {
      const delays: number[] = [];
      const original = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return original(fn, 0);
      }) as typeof globalThis.setTimeout);
      return delays;
    }

    it('503 then 200: retries after honoring Retry-After (seconds → ms)', async () => {
      const delays = captureBackoffDelays();
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          if (hits === 1) {
            return HttpResponse.json({ error: 'saturated' }, { status: 503, headers: { 'Retry-After': '2' } });
          }
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('ok');
      expect(hits).toBe(2);
      expect(delays).toEqual([2000]);
    });

    it('503 exhausted → transient_failure carrying message + last retryAfterMs, bounded retry count', async () => {
      captureBackoffDelays();
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          return HttpResponse.json({ error: 'whisper-ollama down' }, { status: 503, headers: { 'Retry-After': '1' } });
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('transient_failure');
      if (result.kind !== 'transient_failure') throw new Error('expected transient_failure');
      expect(result.message).toBe('whisper-ollama down');
      expect(result.retryAfterMs).toBe(1000);
      expect(hits).toBe(EARWITNESS_ATTRIBUTION_MAX_RETRIES + 1);
    });

    it('missing Retry-After → falls back to the default backoff (no NaN)', async () => {
      const delays = captureBackoffDelays();
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          if (hits === 1) return HttpResponse.json({ error: 'busy' }, { status: 503 });
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('ok');
      expect(delays).toEqual([EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS]);
      expect(delays[0]).not.toBeNaN();
    });

    it('non-numeric Retry-After → falls back to the default backoff (no NaN)', async () => {
      const delays = captureBackoffDelays();
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          if (hits === 1) return HttpResponse.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': 'soon' } });
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('ok');
      expect(delays).toEqual([EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS]);
    });

    it('clamps an oversized Retry-After to the max backoff', async () => {
      const delays = captureBackoffDelays();
      let hits = 0;
      server.use(
        http.post(ATTR_URL, () => {
          hits++;
          if (hits === 1) return HttpResponse.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '99999' } });
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x' });

      expect(result.kind).toBe('ok');
      expect(delays).toEqual([EARWITNESS_ATTRIBUTION_MAX_BACKOFF_MS]);
    });
  });

  describe('transport / timeout', () => {
    it('a call exceeding timeoutMs surfaces a typed failure (no unhandled throw)', async () => {
      server.use(
        http.post(ATTR_URL, async () => {
          await delay(200);
          return HttpResponse.json(detectionOnlyBody());
        }),
      );

      const result = await analyzeAttribution({ baseUrl: BASE_URL, apiKey: API_KEY, path: 'x', timeoutMs: 20 });
      expect(result.kind).toBe('transient_failure');
    });
  });
});
