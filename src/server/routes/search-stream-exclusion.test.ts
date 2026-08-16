/**
 * #2375 AC14 — the interactive SSE surface runs its own inline executor, and it is the surface an
 * operator watches during exactly the incident this issue exists for. There is no documented
 * exception: within one SSE search a transport-failed indexer receives exactly one attempt and
 * produces exactly one `indexer-error` frame.
 *
 * This drives the real `IndexerSearchService` over real HTTP — a mocked `searchAllStreaming` would
 * bypass every mechanism under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { SearchSessionManager } from '../services/search-session.js';
import { IndexerService } from '../services/indexer.service.js';
import { IndexerSearchService } from '../services/indexer-search.service.js';
import { buildQueryLadder } from '../services/search-query-ladder.js';
import * as searchPipeline from '../services/search-pipeline.js';
import authPlugin from '../plugins/auth.js';
import { fetchSseEvents } from '../__tests__/sse-helpers.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import type { AuthService } from '../services/auth.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { IndexerService as IndexerServiceType } from '../services/indexer.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const STREAM_TOKEN = 'valid-stream-token';
const TITLE = 'Kings: Stormlight Archive: Special Edition';
const AUTHOR = 'Sanderson';
const LADDER_LENGTH = buildQueryLadder({ title: TITLE, author: AUTHOR }).length;

const EMPTY_POST_PROCESS_RESULT = {
  results: [],
  durationUnknown: false,
  unsupportedResults: { count: 0, titles: [] },
};

function response() {
  return {
    results: [],
    parseStats: { itemsObserved: 0, kept: 0, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

function authService(): AuthService {
  return {
    validateApiKey: vi.fn().mockResolvedValue(true),
    getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
    verifyStreamToken: vi.fn().mockImplementation((token: string) =>
      token === STREAM_TOKEN ? { kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } : null),
    verifySessionCookie: vi.fn().mockReturnValue(null),
    getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
    hasUser: vi.fn().mockResolvedValue(true),
  } as unknown as AuthService;
}

function buildSearchService(legs: Array<{ id: number; name: string; search: Mock }>) {
  const rows = legs.map((leg, index) => createMockDbIndexer({ id: leg.id, name: leg.name, type: 'torznab', priority: index, settings: {} }));
  const db = createMockDb();
  db.select.mockReturnValue(mockDbChain(rows));
  db.update.mockReturnValue(mockDbChain(rows));
  const log = createMockLogger();
  const service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log), undefined, () => 0);
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  vi.spyOn(service, 'getAdapter').mockImplementation(async (indexer) => ({
    type: 'torznab', name: indexer.name, search: byId.get(indexer.id)!.search, test: vi.fn(),
  }) as never);
  // #2376's cross-run breaker would suppress later rungs on its own clock; hold it open so this
  // route test can only be measuring #2375.
  vi.spyOn(service, 'reserveSearchAttempt').mockImplementation((id) => ({
    allowed: true, generation: service.getFailureGeneration(id), snapshot: service.getFailureSnapshot(id),
  }));
  return new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), service);
}

async function buildApp(search: IndexerSearchService, sessionManager = new SearchSessionManager()) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(authPlugin, { authService: authService() });

  const { searchStreamRoutes } = await import('./search-stream.js');
  await searchStreamRoutes(
    app,
    search,
    { getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) } as unknown as BlacklistService,
    { get: vi.fn().mockResolvedValue({}) } as unknown as SettingsService,
    { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as unknown as IndexerServiceType,
    sessionManager,
  );
  return { app, sessionManager };
}

function streamUrl(): string {
  const params = new URLSearchParams({ q: TITLE, title: TITLE, author: AUTHOR, token: STREAM_TOKEN });
  return `/api/search/stream?${params.toString()}`;
}

beforeEach(() => {
  initializeKey(TEST_KEY);
  vi.spyOn(searchPipeline, 'postProcessSearchResults').mockResolvedValue(EMPTY_POST_PROCESS_RESULT);
});
afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

describe('#2375 AC14 — the interactive SSE search', () => {
  it('spans more than one rung for this fixture, or the count below proves nothing', () => {
    expect(LADDER_LENGTH).toBeGreaterThan(1);
  });

  it('attempts a transport-failed indexer once and emits exactly one indexer-error frame', async () => {
    const dead = vi.fn().mockRejectedValue(Object.assign(new Error('Connection refused on port 443'), { code: 'ECONNREFUSED' }));
    const alive = vi.fn().mockResolvedValue(response());
    const { app } = await buildApp(buildSearchService([
      { id: 1, name: 'AudioBookBay', search: dead },
      { id: 2, name: 'Torznab', search: alive },
    ]));

    try {
      const { events } = await fetchSseEvents(app, streamUrl());

      const errorFrames = events.filter((e) => e.event === 'indexer-error');
      expect(errorFrames).toHaveLength(1);
      expect(errorFrames[0]!.data).toMatchObject({ indexerId: 1, name: 'AudioBookBay', error: 'Connection refused on port 443' });
      expect(dead).toHaveBeenCalledTimes(1);
      expect(alive).toHaveBeenCalledTimes(LADDER_LENGTH);
      expect(events.some((e) => e.event === 'search-complete')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('re-asks an indexer that failed on this query alone, on every later rung', async () => {
    const picky = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 400: Bad Request'), { httpStatus: 400 }))
      .mockResolvedValue(response());
    const alive = vi.fn().mockResolvedValue(response());
    const { app } = await buildApp(buildSearchService([
      { id: 1, name: 'AudioBookBay', search: picky },
      { id: 2, name: 'Torznab', search: alive },
    ]));

    try {
      await fetchSseEvents(app, streamUrl());

      expect(picky).toHaveBeenCalledTimes(LADDER_LENGTH);
    } finally {
      await app.close();
    }
  });

  /**
   * The cancel endpoint reaches the session manager, which is what the leg actually observes; the
   * endpoint's own auth contract is pinned by the existing route suite. What matters here is that
   * a cancelled indexer routes through `indexer-cancelled` and is never worded as a failure — an
   * exclusion rule that read the error's shape instead of the signal would report one.
   */
  it('routes a per-indexer cancellation to indexer-cancelled and never to indexer-error', async () => {
    const sessionManager = new SearchSessionManager();
    const sessionIds = new Set<string>();
    const create = sessionManager.create.bind(sessionManager);
    vi.spyOn(sessionManager, 'create').mockImplementation((indexers) => {
      const session = create(indexers);
      sessionIds.add(session.sessionId);
      return session;
    });
    const cancelled = vi.fn().mockImplementation(async () => {
      for (const sessionId of sessionIds) sessionManager.cancel(sessionId, 1);
      throw new Error('aborted');
    });
    const alive = vi.fn().mockResolvedValue(response());
    const { app } = await buildApp(buildSearchService([
      { id: 1, name: 'AudioBookBay', search: cancelled },
      { id: 2, name: 'Torznab', search: alive },
    ]), sessionManager);

    try {
      const { events } = await fetchSseEvents(app, streamUrl());

      expect(events.filter((e) => e.event === 'indexer-cancelled')).toHaveLength(1);
      expect(events.filter((e) => e.event === 'indexer-error')).toHaveLength(0);
      expect(alive).toHaveBeenCalledTimes(LADDER_LENGTH);
      expect(events.some((e) => e.event === 'search-complete')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
