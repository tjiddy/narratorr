import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse, delay } from 'msw';
import { PlexConnector, resolveServerPath, classifyServerPath, type PlexConnectorConfig } from './plex.js';
import { ConnectorRequestError } from './errors.js';
import type { ConnectorImportBatch } from './types.js';

const BASE_URL = 'http://plex.test:32400';
const IDENTITY_URL = `${BASE_URL}/identity`;
const SECTIONS_URL = `${BASE_URL}/library/sections`;
const REFRESH_URL = `${BASE_URL}/library/sections/1/refresh`;

const SECTIONS_BODY = {
  MediaContainer: {
    Directory: [
      { key: '1', title: 'Audiobooks' },
      { key: '2', title: 'Podcasts' },
    ],
  },
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConnector(overrides: Partial<PlexConnectorConfig> = {}) {
  return new PlexConnector({ baseUrl: BASE_URL, token: 'plex-token', sectionId: '1', ...overrides });
}

const SIGNAL = new AbortController().signal;

function batchFor(...libraryPaths: string[]): ConnectorImportBatch {
  return { reasons: ['import'], items: libraryPaths.map((p, i) => ({ bookId: i + 1, title: `Book ${i + 1}`, libraryPath: p })) };
}

describe('PlexConnector', () => {
  describe('test()', () => {
    it('returns { success: true } and sends X-Plex-Token + Accept: application/json (not Authorization)', async () => {
      let tokenHeader: string | null = null;
      let acceptHeader: string | null = null;
      let authHeader: string | null = null;
      server.use(
        http.get(IDENTITY_URL, ({ request }) => {
          tokenHeader = request.headers.get('X-Plex-Token');
          acceptHeader = request.headers.get('Accept');
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ MediaContainer: {} });
        }),
        http.get(SECTIONS_URL, () => HttpResponse.json(SECTIONS_BODY)),
      );

      const result = await makeConnector().test();

      expect(result.success).toBe(true);
      expect(tokenHeader).toBe('plex-token');
      expect(acceptHeader).toBe('application/json');
      expect(authHeader).toBeNull();
    });

    it('returns fieldErrors.token on 401 without throwing', async () => {
      server.use(http.get(IDENTITY_URL, () => HttpResponse.json({}, { status: 401 })));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.token).toBeDefined();
    });

    it('returns fieldErrors.token on 403', async () => {
      server.use(http.get(IDENTITY_URL, () => HttpResponse.json({}, { status: 403 })));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.token).toBeDefined();
    });

    it('returns fieldErrors.baseUrl on connection failure', async () => {
      server.use(http.get(IDENTITY_URL, () => HttpResponse.error()));
      const result = await makeConnector().test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.baseUrl).toBeDefined();
    });

    it('returns fieldErrors.sectionId when the configured section is absent', async () => {
      server.use(
        http.get(IDENTITY_URL, () => HttpResponse.json({ MediaContainer: {} })),
        http.get(SECTIONS_URL, () => HttpResponse.json(SECTIONS_BODY)),
      );
      const result = await makeConnector({ sectionId: '99' }).test();
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.sectionId).toBeDefined();
    });
  });

  describe('listTargets()', () => {
    it('maps Directory entries (key → id, title → name) into ConnectorTarget[]', async () => {
      server.use(http.get(SECTIONS_URL, () => HttpResponse.json(SECTIONS_BODY)));
      const targets = await makeConnector().listTargets();
      expect(targets).toEqual([
        { id: '1', name: 'Audiobooks' },
        { id: '2', name: 'Podcasts' },
      ]);
    });

    it('returns [] when the MediaContainer has no Directory', async () => {
      server.use(http.get(SECTIONS_URL, () => HttpResponse.json({ MediaContainer: {} })));
      expect(await makeConnector().listTargets()).toEqual([]);
    });

    it('throws ConnectorRequestError on a malformed/non-Zod body', async () => {
      server.use(http.get(SECTIONS_URL, () => HttpResponse.json({ wrong: 'shape' })));
      await expect(makeConnector().listTargets()).rejects.toBeInstanceOf(ConnectorRequestError);
    });

    it('throws ConnectorRequestError on a non-JSON body', async () => {
      server.use(http.get(SECTIONS_URL, () => HttpResponse.text('<xml>not json</xml>')));
      await expect(makeConnector().listTargets()).rejects.toBeInstanceOf(ConnectorRequestError);
    });

    it('throws (token field) on 401 and (baseUrl) on connection failure', async () => {
      server.use(http.get(SECTIONS_URL, () => HttpResponse.json({}, { status: 401 })));
      await expect(makeConnector().listTargets()).rejects.toMatchObject({ retryable: false, fieldErrors: { token: expect.any(String) } });

      server.use(http.get(SECTIONS_URL, () => HttpResponse.error()));
      await expect(makeConnector().listTargets()).rejects.toMatchObject({ retryable: true, fieldErrors: { baseUrl: expect.any(String) } });
    });
  });

  describe('refreshImport() — path mapping, dedupe, batching', () => {
    it('two items resolving to the SAME server path → exactly one targeted refresh', async () => {
      let count = 0;
      server.use(http.get(REFRESH_URL, () => { count++; return HttpResponse.json({}); }));
      const result = await makeConnector().refreshImport(batchFor('/lib/Dune', '/lib/Dune'), SIGNAL);
      expect(count).toBe(1);
      expect(result.success).toBe(true);
    });

    it('two items resolving to DISTINCT server paths → two requests, each path correctly set', async () => {
      const paths: string[] = [];
      server.use(http.get(REFRESH_URL, ({ request }) => {
        paths.push(new URL(request.url).searchParams.get('path')!);
        return HttpResponse.json({});
      }));
      await makeConnector().refreshImport(batchFor('/lib/A', '/lib/B'), SIGNAL);
      expect(paths.sort()).toEqual(['/lib/A', '/lib/B']);
    });

    it('encodes special characters in path exactly once (no double-encoding)', async () => {
      let decodedPath: string | null = null;
      server.use(http.get(REFRESH_URL, ({ request }) => {
        decodedPath = new URL(request.url).searchParams.get('path');
        return HttpResponse.json({});
      }));
      await makeConnector().refreshImport(batchFor('/lib/a b&c#%'), SIGNAL);
      // searchParams.get decodes once; a single round-trip means no double-encoding.
      expect(decodedPath).toBe('/lib/a b&c#%');
    });

    it('applies a longest-prefix path mapping (local → server)', async () => {
      let decodedPath: string | null = null;
      server.use(http.get(REFRESH_URL, ({ request }) => {
        decodedPath = new URL(request.url).searchParams.get('path');
        return HttpResponse.json({});
      }));
      const connector = makeConnector({ pathMappings: [{ localPath: '/library', serverPath: '/data/media' }] });
      await connector.refreshImport(batchFor('/library/audiobooks/Dune'), SIGNAL);
      expect(decodedPath).toBe('/data/media/audiobooks/Dune');
    });

    it('no mapping match with a valid libraryPath → PASSTHROUGH (one targeted refresh, not a skip)', async () => {
      let count = 0;
      let decodedPath: string | null = null;
      server.use(http.get(REFRESH_URL, ({ request }) => {
        count++;
        decodedPath = new URL(request.url).searchParams.get('path');
        return HttpResponse.json({});
      }));
      const connector = makeConnector({ pathMappings: [{ localPath: '/other', serverPath: '/srv' }] });
      const result = await connector.refreshImport(batchFor('/lib/Dune'), SIGNAL);
      expect(count).toBe(1);
      expect(decodedPath).toBe('/lib/Dune');
      expect(result.success).toBe(true);
    });

    it('no-derivable-path item with fallback OFF → no targeted, no section-wide; item skipped in message', async () => {
      let count = 0;
      server.use(http.get(REFRESH_URL, () => { count++; return HttpResponse.json({}); }));
      const result = await makeConnector().refreshImport(batchFor('   '), SIGNAL);
      expect(count).toBe(0);
      expect(result).toMatchObject({ success: true, skipped: 1, passthrough: 0, resolvedServerPaths: [], message: expect.stringContaining('skipped 1') });
    });

    it('no-derivable-path item with fallback ON → exactly one section-wide refresh (no path param)', async () => {
      let pathParam: string | null = 'unset';
      let count = 0;
      server.use(http.get(REFRESH_URL, ({ request }) => {
        count++;
        pathParam = new URL(request.url).searchParams.get('path');
        return HttpResponse.json({});
      }));
      const result = await makeConnector({ fallbackToFullRefresh: true }).refreshImport(batchFor('  '), SIGNAL);
      expect(count).toBe(1);
      expect(pathParam).toBeNull();
      expect(result.success).toBe(true);
    });

    it('all derivable paths 200 → { success: true, message }', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.json({})));
      const result = await makeConnector().refreshImport(batchFor('/lib/A', '/lib/B'), SIGNAL);
      expect(result.success).toBe(true);
      expect(result.message).toContain('2 paths');
    });
  });

  // Structured outcome fields (#1505): the adapter must hand the service the
  // counts + resolved paths so the service logs the right LEVEL without parsing
  // the message string. passthrough/skip are classified from the mapping match
  // state, not by comparing the resolved string to the input (F3).
  describe('refreshImport() — structured outcome fields (#1505)', () => {
    function countingRefresh() {
      const requests: (string | null)[] = [];
      server.use(http.get(REFRESH_URL, ({ request }) => {
        requests.push(new URL(request.url).searchParams.get('path'));
        return HttpResponse.json({});
      }));
      return requests;
    }

    it('mapping-only batch → passthrough:0, skipped:0; resolvedServerPaths holds the distinct mapped serverPaths', async () => {
      countingRefresh();
      const connector = makeConnector({ pathMappings: [{ localPath: '/lib', serverPath: '/srv' }] });
      const result = await connector.refreshImport(batchFor('/lib/A', '/lib/B'), SIGNAL);
      expect(result.passthrough).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.fallbackRefreshed).toBeUndefined();
      expect([...result.resolvedServerPaths!].sort()).toEqual(['/srv/A', '/srv/B']);
    });

    it('identity mapping (serverPath === localPath) → passthrough:0 (it matched), path in resolvedServerPaths (F3)', async () => {
      countingRefresh();
      const connector = makeConnector({ pathMappings: [{ localPath: '/lib', serverPath: '/lib' }] });
      const result = await connector.refreshImport(batchFor('/lib/Dune'), SIGNAL);
      // Resolves to the same string as the input, yet a mapping MATCHED → not passthrough.
      expect(result.passthrough).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.resolvedServerPaths).toEqual(['/lib/Dune']);
    });

    it('pure-passthrough batch (no mappings) → passthrough:N, skipped:0; unchanged paths in resolvedServerPaths', async () => {
      countingRefresh();
      const result = await makeConnector({ pathMappings: [] }).refreshImport(batchFor('/lib/A', '/lib/B'), SIGNAL);
      expect(result.passthrough).toBe(2);
      expect(result.skipped).toBe(0);
      expect([...result.resolvedServerPaths!].sort()).toEqual(['/lib/A', '/lib/B']);
    });

    it('all-skipped, fallback OFF → skipped:N, passthrough:0, resolvedServerPaths:[], zero requests, no full refresh', async () => {
      const requests = countingRefresh();
      const result = await makeConnector().refreshImport(batchFor('   ', ''), SIGNAL);
      expect(requests).toHaveLength(0);
      expect(result.skipped).toBe(2);
      expect(result.passthrough).toBe(0);
      expect(result.fallbackRefreshed).toBeUndefined();
      expect(result.resolvedServerPaths).toEqual([]);
    });

    it('all-skipped, fallback ON → fallbackRefreshed:N, skipped:0; one section refresh; message notes the rescue', async () => {
      const requests = countingRefresh();
      const result = await makeConnector({ fallbackToFullRefresh: true }).refreshImport(batchFor('  ', ''), SIGNAL);
      expect(requests).toEqual([null]); // exactly one section-wide refresh, no path param
      expect(result.fallbackRefreshed).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.passthrough).toBe(0);
      expect(result.message).toContain('full section refresh');
    });

    it('mixed batch (mapped + passthrough + skip), fallback OFF → skipped:1, passthrough:1, two targeted requests; message notes passthrough', async () => {
      const requests = countingRefresh();
      const connector = makeConnector({ pathMappings: [{ localPath: '/map', serverPath: '/srv' }] });
      const result = await connector.refreshImport(batchFor('/map/X', '/other/Y', '   '), SIGNAL);
      expect(requests.filter((p) => p !== null)).toHaveLength(2); // two targeted, no fallback
      expect(result.skipped).toBe(1);
      expect(result.passthrough).toBe(1);
      expect(result.message).toContain('passthrough');
      expect([...result.resolvedServerPaths!].sort()).toEqual(['/other/Y', '/srv/X']);
    });
  });

  // estimateRequestCount feeds the service's scaled flush-timeout watchdog (#1506
  // AC1); it MUST mirror the request plan refreshImport actually executes.
  describe('estimateRequestCount() — request plan for the scaled flush timeout', () => {
    it('counts distinct derivable server paths (deduped), no I/O', () => {
      // Two distinct paths + a duplicate of the first → 2 requests.
      expect(makeConnector().estimateRequestCount(batchFor('/lib/A', '/lib/B', '/lib/A'))).toBe(2);
    });

    it('excludes no-derivable-path items when the fallback is OFF', () => {
      expect(makeConnector().estimateRequestCount(batchFor('/lib/A', '   '))).toBe(1);
    });

    it('adds one for the section-wide fallback when skipped items exist and fallback is ON', () => {
      expect(makeConnector({ fallbackToFullRefresh: true }).estimateRequestCount(batchFor('/lib/A', '  '))).toBe(2);
    });

    it('does not add the fallback request when nothing is skipped', () => {
      expect(makeConnector({ fallbackToFullRefresh: true }).estimateRequestCount(batchFor('/lib/A', '/lib/B'))).toBe(2);
    });

    it('returns 0 for an all-skipped batch with fallback OFF', () => {
      expect(makeConnector().estimateRequestCount(batchFor('   ', ''))).toBe(0);
    });
  });

  describe('refreshImport() — status taxonomy (F13)', () => {
    it('401/403 → throws non-retryable with fieldErrors.token', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.json({}, { status: 401 })));
      await expect(makeConnector().refreshImport(batchFor('/lib/A'), SIGNAL)).rejects.toMatchObject({
        retryable: false,
        fieldErrors: { token: expect.any(String) },
      });
    });

    it('404 → throws non-retryable with fieldErrors.sectionId', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.json({}, { status: 404 })));
      await expect(makeConnector().refreshImport(batchFor('/lib/A'), SIGNAL)).rejects.toMatchObject({
        retryable: false,
        fieldErrors: { sectionId: expect.any(String) },
      });
    });

    it('5xx → throws retryable', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.json({}, { status: 503 })));
      await expect(makeConnector().refreshImport(batchFor('/lib/A'), SIGNAL)).rejects.toMatchObject({ retryable: true });
    });

    it('400 / other non-2xx → throws non-retryable', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.json({}, { status: 400 })));
      await expect(makeConnector().refreshImport(batchFor('/lib/A'), SIGNAL)).rejects.toMatchObject({ retryable: false });
    });

    it('transport/DNS failure → throws retryable scoped to baseUrl', async () => {
      server.use(http.get(REFRESH_URL, () => HttpResponse.error()));
      await expect(makeConnector().refreshImport(batchFor('/lib/A'), SIGNAL)).rejects.toMatchObject({
        retryable: true,
        fieldErrors: { baseUrl: expect.any(String) },
      });
    });

    it('aborted signal mid-flight → in-flight fetch aborts and the call throws', async () => {
      server.use(http.get(REFRESH_URL, async () => { await delay('infinite'); return HttpResponse.json({}); }));
      const controller = new AbortController();
      const promise = makeConnector().refreshImport(batchFor('/lib/A'), controller.signal);
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(ConnectorRequestError);
    });

    it('mixed batch fail-fast: first path 5xx → throws retryable after first failure, second path NOT requested', async () => {
      let bCount = 0;
      server.use(http.get(REFRESH_URL, ({ request }) => {
        const path = new URL(request.url).searchParams.get('path');
        if (path === '/lib/A') return HttpResponse.json({}, { status: 500 });
        bCount++;
        return HttpResponse.json({});
      }));
      await expect(makeConnector().refreshImport(batchFor('/lib/A', '/lib/B'), SIGNAL)).rejects.toMatchObject({ retryable: true });
      expect(bCount).toBe(0);
    });
  });
});

describe('resolveServerPath', () => {
  it('longest-prefix wins when multiple mappings match', () => {
    const mappings = [
      { localPath: '/lib', serverPath: '/srv' },
      { localPath: '/lib/audiobooks', serverPath: '/data/ab' },
    ];
    expect(resolveServerPath('/lib/audiobooks/Dune', mappings)).toBe('/data/ab/Dune');
  });

  it('no match → passthrough (libraryPath unchanged, non-empty)', () => {
    expect(resolveServerPath('/lib/Dune', [{ localPath: '/other', serverPath: '/srv' }])).toBe('/lib/Dune');
  });

  it('normalizes trailing slashes on both localPath and the item path', () => {
    expect(resolveServerPath('/lib/Dune/', [{ localPath: '/lib/', serverPath: '/srv/' }])).toBe('/srv/Dune/');
  });

  it('empty/whitespace libraryPath → no-derivable-path (empty string)', () => {
    expect(resolveServerPath('', [])).toBe('');
    expect(resolveServerPath('   ', [])).toBe('');
  });

  it('matched mapping with empty/whitespace serverPath → no-derivable-path (empty string), NOT passthrough', () => {
    expect(resolveServerPath('/lib/Dune', [{ localPath: '/lib', serverPath: '   ' }])).toBe('');
  });
});

describe('classifyServerPath — match KIND (drives passthrough/skip accounting, F3)', () => {
  it('mapping match → kind: mapped', () => {
    expect(classifyServerPath('/lib/Dune', [{ localPath: '/lib', serverPath: '/srv' }])).toEqual({ kind: 'mapped', path: '/srv/Dune' });
  });

  it('identity mapping (serverPath === localPath) → kind: mapped even though output === input', () => {
    // The crux of F3: do NOT infer passthrough from output === input.
    expect(classifyServerPath('/lib/Dune', [{ localPath: '/lib', serverPath: '/lib' }])).toEqual({ kind: 'mapped', path: '/lib/Dune' });
  });

  it('no mapping match → kind: passthrough (path unchanged)', () => {
    expect(classifyServerPath('/lib/Dune', [{ localPath: '/other', serverPath: '/srv' }])).toEqual({ kind: 'passthrough', path: '/lib/Dune' });
  });

  it('empty/whitespace input → kind: skip', () => {
    expect(classifyServerPath('   ', [])).toEqual({ kind: 'skip', path: '' });
  });

  it('matched mapping with empty serverPath → kind: skip', () => {
    expect(classifyServerPath('/lib/Dune', [{ localPath: '/lib', serverPath: '  ' }])).toEqual({ kind: 'skip', path: '' });
  });
});
