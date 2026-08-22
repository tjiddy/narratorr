import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { SearchSessionManager } from '../services/search-session.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { AuthService } from '../services/auth.service.js';
import { DEFAULT_SETTINGS } from '@shared/schemas/settings/registry.js';
import authPlugin from '../plugins/auth.js';
import * as searchPipeline from '../services/search-pipeline.js';
import * as enrichModule from '../utils/enrich-usenet-languages.js';
import { enrichmentCache } from '../utils/enrichment-cache.js';
import { fetchSseEvents } from '../__tests__/sse-helpers.js';
import { captureDeadlineTimers, type ArmedDeadlineTimer } from '../__tests__/helpers.js';
import { withSearchDeadline, _resetSearchRegistryForTesting } from '../services/search-deadline.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import { HEARTBEAT_INTERVAL_MS } from '../utils/sse-stream.js';

// The enrichment tail's only network boundary. Mocked file-wide so the #2573 cases can count NZB
// fetches; every describe above searches torrents, which never reach phase 2.
vi.mock('@core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@core/utils/network-service.js')>();
  return {
    ...actual,
    fetchWithSsrfRedirect: vi.fn(),
    createSsrfSafeDispatcher: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  };
});

import { fetchWithSsrfRedirect, createSsrfSafeDispatcher } from '@core/utils/network-service.js';

const HB_FRAME = 'event: hb\ndata: {}\n\n';

const EMPTY_POST_PROCESS_RESULT = {
  results: [],
  durationUnknown: false,
  unsupportedResults: { count: 0, titles: [] },
};

function createMockReplyAndRequest(_query = 'test+query') {
  const writeHead = vi.fn();
  const write = vi.fn();
  const hijack = vi.fn();
  const onClose = vi.fn();

  const end = vi.fn();
  const reply = {
    raw: { writeHead, write, end },
    hijack,
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply;

  const request = {
    raw: { on: onClose },
    query: { q: 'test query', limit: '50' },
    log: {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    },
  } as unknown as FastifyRequest;

  return { reply, request, writeHead, write, hijack, onClose };
}

function createMockIndexerSearchService(results: Array<{ indexerId: number; results: Array<Record<string, unknown>> }> = []) {
  return {
    getEnabledIndexers: vi.fn().mockResolvedValue([
      { id: 1, name: 'AudioBookBay' },
      { id: 2, name: 'MAM' },
    ]),
    searchAllStreaming: vi.fn().mockImplementation(
      async (_query: string, _options: unknown, _controllers: Map<number, AbortController>, callbacks: {
        onComplete: (indexerId: number, name: string, resultCount: number, elapsedMs: number) => void;
        onError: (indexerId: number, name: string, error: string, elapsedMs: number) => void;
      }) => {
        for (const r of results) {
          callbacks.onComplete(r.indexerId, `Indexer-${r.indexerId}`, r.results.length, 100);
        }
        return results.flatMap(r => r.results);
      },
    ),
  } as unknown as IndexerSearchService;
}

function createMockBlacklistService() {
  return {
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(),
      blacklistedGuids: new Set<string>(),
    }),
  } as unknown as BlacklistService;
}

function createMockSettingsService() {
  return {
    get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS.quality),
  } as unknown as SettingsService;
}

const mockIndexer = {
  getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
} as unknown as IndexerService;

describe('searchStreamRoutes', () => {
  let sessionManager: SearchSessionManager;
  let indexerService: ReturnType<typeof createMockIndexerSearchService>;
  let blacklistService: ReturnType<typeof createMockBlacklistService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let streamHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null;
  let cancelHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null;
  let postProcessSpy: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    postProcessSpy = vi.spyOn(searchPipeline, 'postProcessSearchResults')
      .mockResolvedValue(EMPTY_POST_PROCESS_RESULT);
    sessionManager = new SearchSessionManager();
    indexerService = createMockIndexerSearchService();
    blacklistService = createMockBlacklistService();
    settingsService = createMockSettingsService();
    streamHandler = null;
    cancelHandler = null;

    const { searchStreamRoutes } = await import('./search-stream.js');

    const mockApp = {
      get: (_path: string, _opts: unknown, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        streamHandler = handler;
      },
      post: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        cancelHandler = handler;
      },
    };

    await searchStreamRoutes(
      mockApp as never,
      indexerService,
      blacklistService,
      settingsService,
      mockIndexer,
      sessionManager,
    );
  });

  afterEach(() => {
    postProcessSpy.mockRestore();
  });

  describe('GET /api/search/stream', () => {
    it('sets correct SSE headers and hijacks reply', async () => {
      const { reply, request, writeHead, hijack } = createMockReplyAndRequest();

      await streamHandler!(request, reply);

      expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      }));
      expect(hijack).toHaveBeenCalled();
    });

    it('streams search-start event with session ID and indexer list', async () => {
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, _cb: unknown) => [],
      );

      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      const searchStartCall = write.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: search-start'),
      );
      expect(searchStartCall).toBeDefined();

      const dataLine = (searchStartCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      const data = JSON.parse(dataLine!.replace('data: ', ''));
      expect(data.sessionId).toBeDefined();
      expect(data.indexers).toBeInstanceOf(Array);
    });

    it('streams search-complete with full SearchResponse shape', async () => {
      const mockProcessed = {
        results: [{ title: 'Book', indexer: 'test' }],
        durationUnknown: true,
        unsupportedResults: { count: 1, titles: ['Multi-part'] },
      };
      postProcessSpy.mockResolvedValue(mockProcessed);

      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      const completeCall = write.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: search-complete'),
      );
      expect(completeCall).toBeDefined();

      const dataLine = (completeCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      const data = JSON.parse(dataLine!.replace('data: ', ''));
      expect(data).toHaveProperty('results');
      expect(data).toHaveProperty('durationUnknown');
      expect(data).toHaveProperty('unsupportedResults');
    });

    it('streams indexer-cancelled event when onCancelled callback fires', async () => {
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: {
          onComplete: (indexerId: number, name: string, resultCount: number, elapsedMs: number) => void;
          onError: (indexerId: number, name: string, error: string, elapsedMs: number) => void;
          onCancelled: (indexerId: number, name: string) => void;
        }) => {
          callbacks.onCancelled(2, 'MAM');
          return [];
        },
      );

      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      const cancelledCall = write.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: indexer-cancelled'),
      );
      expect(cancelledCall).toBeDefined();

      const dataLine = (cancelledCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      const data = JSON.parse(dataLine!.replace('data: ', ''));
      expect(data).toEqual({ indexerId: 2, name: 'MAM' });
    });

    // #2376 AC6: this route builds its own callbacks rather than using SearchEventSink, so a
    // sink-only test would not prove the breaker skip reaches the client at all.
    it('writes the breaker skip through the existing indexer-error frame, with no new event type', async () => {
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: {
          onError: (indexerId: number, name: string, error: string, elapsedMs: number) => void;
        }) => {
          callbacks.onError(2, 'MAM', 'Skipped — stopped: Connection refused on port 443', 0);
          return [];
        },
      );

      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      const frames = write.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: indexer-error'),
      );
      expect(frames).toHaveLength(1);
      const dataLine = (frames[0]![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      expect(JSON.parse(dataLine!.replace('data: ', ''))).toEqual({
        indexerId: 2,
        name: 'MAM',
        error: 'Skipped — stopped: Connection refused on port 443',
        elapsedMs: 0,
      });
      expect(write.mock.calls.some((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('event: indexer-skipped'))).toBe(false);
    });

    it('registers close handler for client disconnect cleanup', async () => {
      const { reply, request, onClose } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      expect(onClose).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('returns 400 without opening SSE stream when query cleans to empty (parens-only)', async () => {
      const { reply, request, writeHead, hijack } = createMockReplyAndRequest();
      (request as { query: Record<string, unknown> }).query = { q: '()', limit: 50 };

      await streamHandler!(request, reply);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/empty/i) }),
      );
      expect(writeHead).not.toHaveBeenCalled();
      expect(hijack).not.toHaveBeenCalled();
      expect(indexerService.searchAllStreaming).not.toHaveBeenCalled();
    });

    it('returns 400 for dots-only query (cleaner strips them)', async () => {
      const { reply, request, writeHead } = createMockReplyAndRequest();
      (request as { query: Record<string, unknown> }).query = { q: '...', limit: 50 };

      await streamHandler!(request, reply);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(writeHead).not.toHaveBeenCalled();
      expect(indexerService.searchAllStreaming).not.toHaveBeenCalled();
    });

    it('#1904 returns 400 for a "?!"-only query (cleaner strips them) before opening SSE', async () => {
      const { reply, request, writeHead, hijack } = createMockReplyAndRequest();
      (request as { query: Record<string, unknown> }).query = { q: '?!', limit: 50 };

      await streamHandler!(request, reply);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(writeHead).not.toHaveBeenCalled();
      expect(hijack).not.toHaveBeenCalled();
      expect(indexerService.searchAllStreaming).not.toHaveBeenCalled();
    });

    it('calls reply.hijack() before any reply.raw.write() calls', async () => {
      const callOrder: string[] = [];
      const { reply, request } = createMockReplyAndRequest();

      (reply.hijack as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('hijack');
      });
      (reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('write');
        return true;
      });
      (reply.raw.writeHead as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('writeHead');
      });

      await streamHandler!(request, reply);

      expect(callOrder[0]).toBe('writeHead');
      const hijackIndex = callOrder.indexOf('hijack');
      const firstWriteIndex = callOrder.indexOf('write');
      expect(hijackIndex).toBeGreaterThan(-1);
      expect(firstWriteIndex).toBeGreaterThan(-1);
      expect(hijackIndex).toBeLessThan(firstWriteIndex);
    });
  });

  describe('POST /api/search/stream/:sessionId/cancel/:indexerId', () => {
    it('returns 404 for invalid session ID', async () => {
      const request = {
        params: { sessionId: 'nonexistent', indexerId: '1' },
        log: { debug: vi.fn() },
      } as unknown as FastifyRequest;
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await cancelHandler!(request, reply);

      expect(reply.status).toHaveBeenCalledWith(404);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });

    it('returns 404 for invalid indexer ID within valid session', async () => {
      const session = sessionManager.create([{ id: 1, name: 'Test' }]);
      const request = {
        params: { sessionId: session.sessionId, indexerId: '999' },
        log: { debug: vi.fn() },
      } as unknown as FastifyRequest;
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await cancelHandler!(request, reply);

      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('aborts the specific indexer and returns 200', async () => {
      const session = sessionManager.create([{ id: 1, name: 'Test' }, { id: 2, name: 'Test2' }]);
      const request = {
        params: { sessionId: session.sessionId, indexerId: '1' },
        log: { debug: vi.fn() },
      } as unknown as FastifyRequest;
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await cancelHandler!(request, reply);

      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
      expect(session.controllers.get(1)!.signal.aborted).toBe(true);
      expect(session.controllers.get(2)!.signal.aborted).toBe(false);
    });
  });

  describe('client disconnect cleanup', () => {
    it('invokes close callback which removes session and aborts pending controllers during search', async () => {
      let resolveSearch: (v: never[]) => void;
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        () => new Promise<never[]>((resolve) => { resolveSearch = resolve; }),
      );

      const { reply, request, onClose } = createMockReplyAndRequest();
      const handlerPromise = streamHandler!(request, reply);
      // Flush microtasks until the handler awaits searchAllStreaming.
      await new Promise(resolve => setTimeout(resolve, 0));

      const writeCall = (reply.raw.write as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: search-start'),
      );
      const dataLine = (writeCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      const data = JSON.parse(dataLine!.replace('data: ', ''));
      const sid = data.sessionId as string;

      expect(sessionManager.get(sid)).toBeDefined();
      const session = sessionManager.get(sid)!;

      const closeHandler = onClose.mock.calls[0]![1] as () => void;
      closeHandler();

      expect(sessionManager.get(sid)).toBeUndefined();
      for (const [, controller] of session.controllers) {
        expect(controller.signal.aborted).toBe(true);
      }

      resolveSearch!([] as never[]);
      await handlerPromise;
    });
  });

  describe('in-flight heartbeat', () => {
    // Interval-only fakes preserve real setTimeout(0) for flushing handler awaits.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function hbCount(write: ReturnType<typeof vi.fn>): number {
      return write.mock.calls.filter((c: unknown[]) => c[0] === HB_FRAME).length;
    }

    function deferredSearch() {
      let resolve!: (v: never[]) => void;
      let reject!: (e: unknown) => void;
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        () => new Promise<never[]>((res, rej) => { resolve = res; reject = rej; }),
      );
      return { resolve: () => resolve([] as never[]), reject: (e: unknown) => reject(e) };
    }

    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('emits `hb` heartbeat frames on the shared cadence while searchAllStreaming is in flight, then stops on completion', async () => {
      const search = deferredSearch();
      const { reply, request, write } = createMockReplyAndRequest();
      const handlerPromise = streamHandler!(request, reply);
      await flush();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(hbCount(write)).toBe(2);

      search.resolve();
      await handlerPromise;
      expect(reply.raw.end).toHaveBeenCalled();

      const after = hbCount(write);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(hbCount(write)).toBe(after);
    });

    it('clears the heartbeat when the search rejects (catch path still writes fallback search-complete)', async () => {
      indexerService.searchAllStreaming = vi.fn().mockRejectedValue(new Error('boom'));
      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      const completeCall = write.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('event: search-complete'),
      );
      expect(completeCall).toBeDefined();

      const after = hbCount(write);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(hbCount(write)).toBe(after);
      expect(reply.raw.end).toHaveBeenCalled();
    });

    it('clears the heartbeat when the client disconnects mid-search (and still cleans up the session)', async () => {
      const search = deferredSearch();
      const { reply, request, write, onClose } = createMockReplyAndRequest();
      const handlerPromise = streamHandler!(request, reply);
      await flush();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      const beforeClose = hbCount(write);
      expect(beforeClose).toBe(1);

      const closeHandler = onClose.mock.calls[0]![1] as () => void;
      closeHandler();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(hbCount(write)).toBe(beforeClose);

      search.resolve();
      await handlerPromise;
    });

    it('does not throw or crash when a heartbeat write fails, and stops retrying (AC3)', async () => {
      const search = deferredSearch();
      const { reply, request, write } = createMockReplyAndRequest();
      (write as ReturnType<typeof vi.fn>).mockImplementation((frame: string) => {
        if (frame === HB_FRAME) throw new Error('write after end / broken pipe');
        return true;
      });
      const handlerPromise = streamHandler!(request, reply);
      await flush();

      // An uncaught interval callback has no caller to absorb its failure.
      expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)).not.toThrow();

      const attempts = hbCount(write);
      expect(attempts).toBe(1);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(hbCount(write)).toBe(attempts);

      search.resolve();
      await handlerPromise;
    });

    it('unref()s the heartbeat timer so a pending tick never pins the event loop (AC4)', async () => {
      vi.useRealTimers(); // spy on the real setInterval instead of the fake clock
      const unref = vi.fn();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

      const { reply, request } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });
});

vi.mock('../config.js', () => ({
  config: { authBypass: false, isDev: true },
}));

describe('searchStreamRoutes — app.inject() integration', () => {
  let postProcessSpy: MockInstance;

  // Streams use query tokens; cancellation uses the ambient session-cookie chain.
  const VALID_STREAM_TOKEN = 'valid-stream-token';
  const VALID_COOKIE = 'valid-cookie';

  function createMockAuthService(valid = false) {
    return {
      validateApiKey: vi.fn().mockResolvedValue(valid),
      getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
      verifyStreamToken: vi.fn().mockImplementation((token: string) =>
        token === VALID_STREAM_TOKEN ? { kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } : null),
      verifySessionCookie: vi.fn().mockImplementation((cookie: string) =>
        cookie === VALID_COOKIE
          ? { payload: { username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 1_000_000 }, shouldRenew: false }
          : null),
      getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      hasUser: vi.fn().mockResolvedValue(true),
    } as unknown as AuthService;
  }

  beforeEach(() => {
    postProcessSpy = vi.spyOn(searchPipeline, 'postProcessSearchResults')
      .mockResolvedValue(EMPTY_POST_PROCESS_RESULT);
  });

  afterEach(() => {
    postProcessSpy.mockRestore();
  });

  it('rejects unauthenticated request with 401', async () => {
    const authService = createMockAuthService(false);
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });

    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      createMockIndexerSearchService(),
      createMockBlacklistService(),
      createMockSettingsService(),
      mockIndexer,
      new SearchSessionManager(),
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/search/stream?q=test' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('cancel route returns expected response through registered app path', async () => {
    const authService = createMockAuthService(true);
    const sessionMgr = new SearchSessionManager();
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });

    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      createMockIndexerSearchService(),
      createMockBlacklistService(),
      createMockSettingsService(),
      mockIndexer,
      sessionMgr,
    );
    await app.ready();

    const session = sessionMgr.create([{ id: 1, name: 'Test' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/search/stream/${session.sessionId}/cancel/1`,
      cookies: { narratorr_session: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cancelled: true });

    await app.close();
  });

  it('successful GET with a valid stream token and zero indexers returns SSE stream with empty results', async () => {
    // Fastify inject hangs on hijacked SSE responses; exercise this route over real HTTP.
    const authService = createMockAuthService(true);
    const zeroIndexerSearchService = {
      ...createMockIndexerSearchService(),
      getEnabledIndexers: vi.fn().mockResolvedValue([]),
      searchAllStreaming: vi.fn().mockResolvedValue([]),
    } as unknown as IndexerSearchService;

    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });

    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      zeroIndexerSearchService,
      createMockBlacklistService(),
      createMockSettingsService(),
      mockIndexer,
      new SearchSessionManager(),
    );

    try {
      const { status, headers, events } = await fetchSseEvents(app, `/api/search/stream?q=test&token=${VALID_STREAM_TOKEN}`);

      expect(status).toBe(200);
      expect(headers.get('content-type')).toBe('text/event-stream');
      expect(headers.get('cache-control')).toBe('no-cache');

      const startEvent = events.find(e => e.event === 'search-start');
      expect(startEvent).toBeDefined();
      const startData = startEvent!.data as { sessionId: string; indexers: unknown[] };
      expect(startData.sessionId).toBeDefined();
      expect(startData.indexers).toEqual([]);

      const completeEvent = events.find(e => e.event === 'search-complete');
      expect(completeEvent).toBeDefined();
      const completeData = completeEvent!.data as Record<string, unknown>;
      expect(completeData.results).toEqual([]);
      expect(completeData).toHaveProperty('durationUnknown');
      expect(completeData).toHaveProperty('unsupportedResults');
    } finally {
      await app.close();
    }
  });

  it('cancel route returns 404 for unknown session through registered app path', async () => {
    const authService = createMockAuthService(true);
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });

    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      createMockIndexerSearchService(),
      createMockBlacklistService(),
      createMockSettingsService(),
      mockIndexer,
      new SearchSessionManager(),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search/stream/nonexistent/cancel/1',
      cookies: { narratorr_session: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  describe('cancel route auth matrix (#1453)', () => {
    async function buildCancelApp() {
      const authService = createMockAuthService(true);
      const sessionMgr = new SearchSessionManager();
      const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(cookie);
      await app.register(authPlugin, { authService });
      const { searchStreamRoutes } = await import('./search-stream.js');
      await searchStreamRoutes(
        app,
        createMockIndexerSearchService(),
        createMockBlacklistService(),
        createMockSettingsService(),
        mockIndexer,
        sessionMgr,
      );
      await app.ready();
      const session = sessionMgr.create([{ id: 1, name: 'Test' }]);
      return { app, sessionId: session.sessionId };
    }

    it('rejects an API-key-only cancel with the API-key 401 body (de-god-moded)', async () => {
      const { app, sessionId } = await buildCancelApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/search/stream/${sessionId}/cancel/1`,
          headers: { 'x-api-key': 'valid-key' },
        });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
      } finally {
        await app.close();
      }
    });

    it('rejects a stream-token cancel (cancel is not an SSE endpoint)', async () => {
      const { app, sessionId } = await buildCancelApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/search/stream/${sessionId}/cancel/1?token=${VALID_STREAM_TOKEN}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('accepts a forms-cookie cancel (no CSRF header needed in forms mode)', async () => {
      const { app, sessionId } = await buildCancelApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/search/stream/${sessionId}/cancel/1`,
          cookies: { narratorr_session: VALID_COOKIE },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('rejects an unauthenticated cancel (forms mode, no creds)', async () => {
      const { app, sessionId } = await buildCancelApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/search/stream/${sessionId}/cancel/1`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

});

describe('searchStreamRoutes — unmocked postProcessSearchResults', () => {
  it('runs real postProcessSearchResults when spy is not installed', async () => {
    const sessionManager = new SearchSessionManager();
    const blacklistService = createMockBlacklistService();
    const settingsService = createMockSettingsService();
    const indexerService = createMockIndexerSearchService();

    let streamHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;

    const { searchStreamRoutes } = await import('./search-stream.js');
    const mockApp = {
      get: (_path: string, _opts: unknown, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        streamHandler = handler;
      },
      post: vi.fn(),
    };

    await searchStreamRoutes(mockApp as never, indexerService, blacklistService, settingsService, mockIndexer, sessionManager);

    const { reply, request, write } = createMockReplyAndRequest();
    await streamHandler!(request, reply);

    const completeCall = write.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: search-complete'),
    );
    expect(completeCall).toBeDefined();

    const dataLine = (completeCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
    const data = JSON.parse(dataLine!.replace('data: ', ''));
    expect(data).toHaveProperty('results');
    expect(data).toHaveProperty('durationUnknown');
    expect(data).toHaveProperty('unsupportedResults');
  });
});

const STREAM_TOKEN = 'valid-stream-token';

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

/** The one real-HTTP app for this route: real authPlugin over a stubbed AuthService, never hand-rolled. */
async function buildApp(indexerSearchService: IndexerSearchService, overrides: {
  blacklistService?: BlacklistService;
  indexerService?: IndexerService;
} = {}) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(authPlugin, { authService: authService() });
  const { searchStreamRoutes } = await import('./search-stream.js');
  await searchStreamRoutes(
    app,
    indexerSearchService,
    overrides.blacklistService ?? createMockBlacklistService(),
    createMockSettingsService(),
    overrides.indexerService ?? mockIndexer,
    new SearchSessionManager(),
  );
  return app;
}

describe('GET /api/search/stream — query ladder (#2104)', () => {
  const VALID_STREAM_TOKEN = STREAM_TOKEN;
  const BOOK_TITLE = 'The Churn: An Expanse Novella';
  const AUTHOR = 'James S. A. Corey';
  const CANONICAL_Q = 'The Churn An Expanse Novella James S A Corey';

  const RUNGS = [
    CANONICAL_Q,
    'the churn James S A Corey',
    'an expanse novella James S A Corey',
    'the churn an expanse novella',
    'the churn',
    'an expanse novella',
  ];

  // Completion callbacks distinguish a genuine zero-result rung from a total outage.
  function serviceAnswering(hitQuery: string | null, resultCount = 2) {
    const controllerMaps: Array<Map<number, AbortController>> = [];
    const service = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }, { id: 2, name: 'MAM' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (query: string, _o: unknown, controllers: Map<number, AbortController>, cb: {
          onComplete: (id: number, name: string, count: number, ms: number) => void;
        }) => {
          controllerMaps.push(controllers);
          const hit = query === hitQuery;
          const count = hit ? resultCount : 0;
          cb.onComplete(1, 'AudioBookBay', count, 10);
          cb.onComplete(2, 'MAM', 0, 10);
          return hit ? Array.from({ length: count }, (_v, i) => ({ title: `R${i}`, protocol: 'usenet', indexer: 'AudioBookBay' })) : [];
        },
      ),
    } as unknown as IndexerSearchService;
    return { service, controllerMaps };
  }

  const url = (params: Record<string, string>) =>
    `/api/search/stream?${new URLSearchParams({ token: VALID_STREAM_TOKEN, ...params }).toString()}`;

  const queriesOf = (svc: IndexerSearchService) =>
    vi.mocked(svc.searchAllStreaming).mock.calls.map((c) => c[0] as string);

  let postProcessSpy: MockInstance;
  beforeEach(() => {
    // Preserve the winning rung's results through post-processing.
    postProcessSpy = vi.spyOn(searchPipeline, 'postProcessSearchResults')
      .mockImplementation(async (results) => ({ results, durationUnknown: false, unsupportedResults: { count: 0, titles: [] } }));
  });
  afterEach(() => postProcessSpy.mockRestore());

  it('omits relaxedQuery entirely when rung 1 produced the hits (AC24)', async () => {
    const { service } = serviceAnswering(CANONICAL_Q);
    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual([CANONICAL_Q]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  /**
   * #2422 — the raw `q` is the only apostrophe-bearing text this route ever sees; it is validated
   * but never cleaned, so rung 1 must carry it down while `rung.query` stays exactly as it was.
   */
  it('forwards each rung’s apostrophe form into the search options without moving rung.query', async () => {
    const RAW_Q = "A Dragon Rider's Guide: The Retirement Chronicles";
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      await fetchSseEvents(app, url({ q: RAW_Q, title: "A Dragon Rider's Guide: The Retirement Chronicles", author: AUTHOR }));

      const calls = vi.mocked(service.searchAllStreaming).mock.calls;
      const [rung1Query, rung1Options] = calls[0]!;
      expect(rung1Query).toBe(RAW_Q);
      expect(rung1Options?.queryWithApostrophes).toBe("A Dragon Rider's Guide The Retirement Chronicles");

      // Every rung, not only the first: a relaxed rung is where the fold matters most.
      for (const [, options] of calls) expect(options?.queryWithApostrophes).toBeDefined();

      // Rung 1's query is the caller's `q` verbatim; only relaxed rungs are cleaned (#2104).
      const [relaxedQuery, relaxedOptions] = calls[1]!;
      expect(relaxedQuery).not.toContain("'");
      expect(relaxedOptions?.queryWithApostrophes).toContain("rider's");
    } finally {
      await app.close();
    }
  });

  it('sets relaxedQuery to the winning rung query when rungs 2+ produced the hits (AC24)', async () => {
    const { service } = serviceAnswering(RUNGS[3]!);
    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual(RUNGS.slice(0, 4));
      expect((complete.data as { relaxedQuery?: string }).relaxedQuery).toBe('the churn an expanse novella');
    } finally {
      await app.close();
    }
  });

  // An attempted relaxed rung is not a match; disclosure also requires post-processed hits.
  it('omits relaxedQuery when the ladder exhausts every rung at zero (AC24, F1)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual(RUNGS);
      expect((complete.data as { results: unknown[] }).results).toEqual([]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  it('omits relaxedQuery when a later rung aborts on a total indexer outage (AC24, F1)', async () => {
    let call = 0;
    const service = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, cb: {
          onComplete: (id: number, name: string, count: number, ms: number) => void;
          onError: (id: number, name: string, error: string, ms: number) => void;
        }) => {
          call++;
          // First a genuine zero, then a total outage.
          if (call === 1) cb.onComplete(1, 'AudioBookBay', 0, 10);
          else cb.onError(1, 'AudioBookBay', 'ECONNREFUSED', 10);
          return [];
        },
      ),
    } as unknown as IndexerSearchService;

    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual(RUNGS.slice(0, 2));
      expect((complete.data as { results: unknown[] }).results).toEqual([]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  // A relaxed rung filtered to nothing has nothing to disclose.
  it('omits relaxedQuery when a relaxed rung hit but the gates filtered every result (AC24, F1)', async () => {
    const { service } = serviceAnswering(RUNGS[3]!);
    postProcessSpy.mockImplementation(async () => ({
      results: [],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    }));

    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual(RUNGS.slice(0, 4));
      expect((complete.data as { results: unknown[] }).results).toEqual([]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  // Interactive discovery intentionally has no auto-grab corroboration floor.
  it('still surfaces the franchise siblings the auto path now holds (#2133 AC11)', async () => {
    const FRANCHISE_TITLE = 'Star Wars: The High Republic: Haunted Starlight';
    const FRANCHISE_Q = 'Star Wars The High Republic Haunted Starlight George Mann';
    const PREFIX2_Q = 'star wars the high republic George Mann';
    const siblings = [
      { title: '01 Star Wars-The High Republic-The Eye of Darkness', protocol: 'usenet', indexer: 'AudioBookBay' },
      { title: 'Star Wars: The High Republic: Cataclysm', protocol: 'usenet', indexer: 'AudioBookBay' },
    ];
    const service = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (query: string, _o: unknown, _c: Map<number, AbortController>, cb: {
          onComplete: (id: number, name: string, count: number, ms: number) => void;
        }) => {
          const hit = query === PREFIX2_Q;
          cb.onComplete(1, 'AudioBookBay', hit ? siblings.length : 0, 10);
          return hit ? siblings : [];
        },
      ),
    } as unknown as IndexerSearchService;

    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: FRANCHISE_Q, title: FRANCHISE_TITLE, author: 'George Mann' }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual([FRANCHISE_Q, PREFIX2_Q]);
      expect((complete.data as { results: Array<{ title: string }> }).results.map((r) => r.title))
        .toEqual(siblings.map((s) => s.title));
      expect((complete.data as { relaxedQuery?: string }).relaxedQuery).toBe(PREFIX2_Q);
    } finally {
      await app.close();
    }
  });

  it('surfaces a franchise-dropping release found at the tail rung (#2138 AC9)', async () => {
    const FRANCHISE_TITLE = 'Star Wars: The High Republic: Haunted Starlight';
    const FRANCHISE_Q = 'Star Wars The High Republic Haunted Starlight George Mann';
    const TAIL_Q = 'haunted starlight George Mann';
    const wanted = [{ title: 'Haunted Starlight - George Mann', protocol: 'usenet', indexer: 'AudioBookBay' }];
    const service = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (query: string, _o: unknown, _c: Map<number, AbortController>, cb: {
          onComplete: (id: number, name: string, count: number, ms: number) => void;
        }) => {
          const hit = query === TAIL_Q;
          cb.onComplete(1, 'AudioBookBay', hit ? wanted.length : 0, 10);
          return hit ? wanted : [];
        },
      ),
    } as unknown as IndexerSearchService;

    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: FRANCHISE_Q, title: FRANCHISE_TITLE, author: 'George Mann' }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      expect(queriesOf(service)).toEqual([
        FRANCHISE_Q,
        'star wars the high republic George Mann',
        'the high republic haunted starlight George Mann',
        'star wars haunted starlight George Mann',
        TAIL_Q,
      ]);
      expect((complete.data as { results: Array<{ title: string }> }).results.map((r) => r.title))
        .toEqual(['Haunted Starlight - George Mann']);
      expect((complete.data as { relaxedQuery?: string }).relaxedQuery).toBe(TAIL_Q);
    } finally {
      await app.close();
    }
  });

  // The client replaces counts by indexerId, so the last frame must describe the winning rung.
  it('leaves the winning rung as the last indexer-complete frame per indexer (AC26)', async () => {
    const { service } = serviceAnswering(RUNGS[3]!, 7);
    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const byIndexer = new Map<number, number>();
      for (const e of events.filter((x) => x.event === 'indexer-complete')) {
        const d = e.data as { indexerId: number; resultCount: number };
        byIndexer.set(d.indexerId, d.resultCount);
      }

      expect(byIndexer.get(1)).toBe(7);
      expect(byIndexer.get(2)).toBe(0);
    } finally {
      await app.close();
    }
  });

  // Reusing the controller map preserves aborted indexers across rungs.
  it('passes one sticky controller map to every rung, so a cancelled indexer is not re-queried (AC27)', async () => {
    const cancelledFrames: number[] = [];
    const queriedIndexers: number[][] = [];
    const service = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }, { id: 2, name: 'MAM' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (_q: string, _o: unknown, controllers: Map<number, AbortController>, cb: {
          onComplete: (id: number, name: string, count: number, ms: number) => void;
          onCancelled?: (id: number, name: string) => void;
        }) => {
          const queried: number[] = [];
          for (const [id, controller] of controllers) {
            // Mirror the real pre-adapter guard, including its lack of callback.
            if (controller.signal.aborted) continue;
            queried.push(id);
            if (id === 1) {
              controller.abort();
              cb.onCancelled?.(1, 'AudioBookBay');
              continue;
            }
            cb.onComplete(id, 'MAM', 0, 10);
          }
          queriedIndexers.push(queried);
          return [];
        },
      ),
    } as unknown as IndexerSearchService;

    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      for (const e of events.filter((x) => x.event === 'indexer-cancelled')) {
        cancelledFrames.push((e.data as { indexerId: number }).indexerId);
      }

      expect(queriedIndexers[0]).toEqual([1, 2]);
      expect(queriedIndexers.slice(1).every((ids) => ids.every((id) => id !== 1))).toBe(true);
      // Fresh maps would emit one cancellation frame per rung.
      expect(cancelledFrames).toEqual([1]);
    } finally {
      await app.close();
    }
  });

  // Free-text `q` is user input, not a canonical title to relax.
  it('runs rung 1 only when the optional title param is absent (AC38)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      await fetchSseEvents(app, url({ q: CANONICAL_Q }));
      expect(queriesOf(service)).toEqual([CANONICAL_Q]);
    } finally {
      await app.close();
    }
  });

  // An unusable explicit query must not silently fall back to the canonical title.
  it('still returns 400 for a punctuation-only q even when a usable canonical title is present (D13)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      const { status, events } = await fetchSseEvents(app, url({ q: '??', title: BOOK_TITLE, author: AUTHOR }));

      expect(status).toBe(400);
      expect(events.find((e) => e.event === 'search-start')).toBeUndefined();
      expect(service.searchAllStreaming).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses the user-edited q verbatim as rung 1 while relaxing the canonical title (D13)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      await fetchSseEvents(app, url({ q: 'churn expanse', title: BOOK_TITLE, author: AUTHOR }));

      // The canonical full query remains a candidate because edited rung 1 is distinct.
      expect(queriesOf(service)).toEqual([
        'churn expanse',
        'the churn an expanse novella James S A Corey',
        ...RUNGS.slice(1),
      ]);
    } finally {
      await app.close();
    }
  });
});

// ─── #2568: the interactive stream's own deadline ────────────────────────────
// Every describe above is the success-path parity baseline (case 5) and stays green UNMODIFIED;
// nothing below edits one. If one of them needs editing, the contract has drifted.

const DEADLINE_FIXTURE = {
  title: 'The Churn: An Expanse Novella',
  author: 'James S. A. Corey',
  q: 'The Churn An Expanse Novella James S A Corey',
};
/**
 * Pinned rung count for the fixture above. A colon-free title yields 2 rungs however many words it
 * has, which would make "no further rung ran" vacuous; pinning it reds here if the variant
 * generator changes rather than silently shortening every count that depends on it.
 */
const DEADLINE_LADDER_RUNGS = 6;

type SseFrame = { event: string; data: Record<string, unknown> };

function framesOf(write: ReturnType<typeof vi.fn>): SseFrame[] {
  return write.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((f: unknown): f is string => typeof f === 'string' && f.startsWith('event: '))
    .map((frame: string) => {
      const event = frame.slice('event: '.length, frame.indexOf('\n'));
      const dataLine = frame.split('\n').find((l: string) => l.startsWith('data: '))!;
      return { event, data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown> };
    });
}

/** Heartbeats are cadence noise on a terminal-payload assertion; every other frame is contract. */
const namedFrames = (write: ReturnType<typeof vi.fn>) => framesOf(write).filter(f => f.event !== 'hb');
const completeFrame = (write: ReturnType<typeof vi.fn>) =>
  namedFrames(write).find(f => f.event === 'search-complete')?.data;

function freshIndexerService() {
  return {
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
    recordSearchFailure: vi.fn(),
  } as unknown as IndexerService & { getLanAllowlist: ReturnType<typeof vi.fn>; recordSearchFailure: ReturnType<typeof vi.fn> };
}

/** Sized to survive the default quality gates (minSeeders 1, 50 MB–5 GB) under real post-processing. */
const survivingResult = (overrides: Record<string, unknown> = {}) => ({
  title: 'The Churn',
  protocol: 'torrent',
  indexer: 'AudioBookBay',
  indexerId: 1,
  size: 500 * 1024 * 1024,
  seeders: 10,
  ...overrides,
});

interface StreamingServiceOptions {
  /** 1-based rung to park on a barrier the case releases; omit to never park. */
  parkAt?: number;
  /** The transport query that answers with results; every other rung answers a genuine zero. */
  hitQuery?: string;
  results?: Array<Record<string, unknown>>;
  /** Rungs (1-based) that report a total indexer outage instead of a genuine zero. */
  outageAt?: number[];
  indexers?: Array<{ id: number; name: string }>;
}

/**
 * A `searchAllStreaming` double faithful to the two behaviours this change depends on
 * (`indexer-search.service.ts:447-456,487`): an aborted OUTER signal rejects with an ordinary
 * adapter-shaped error and invokes no callback, while a per-indexer cancellation routes through
 * `onCancelled`. Modelling both is what makes case 9 red if the deadline is threaded in as a
 * session controller instead of the outer signal.
 */
function streamingService(opts: StreamingServiceOptions = {}) {
  const indexers = opts.indexers ?? [{ id: 1, name: 'AudioBookBay' }];
  let admit!: () => void;
  const entered = new Promise<void>((resolve) => { admit = resolve; });
  let open!: () => void;
  const barrier = new Promise<void>((resolve) => { open = resolve; });
  let calls = 0;

  const searchAllStreaming = vi.fn().mockImplementation(async (
    query: string,
    _options: unknown,
    controllers: Map<number, AbortController>,
    callbacks: {
      onComplete: (id: number, name: string, count: number, ms: number) => void;
      onError: (id: number, name: string, error: string, ms: number) => void;
      onCancelled?: (id: number, name: string) => void;
    },
    outerSignal?: AbortSignal,
  ) => {
    const rung = ++calls;
    if (opts.parkAt === rung) { admit(); await barrier; }

    // Guard before subscribing: an already-aborted signal never re-fires its abort event.
    // The message is deliberately an ordinary transport failure — textually indistinguishable from
    // a real one, which is why the route's verdict cannot key on the error's shape (AC5).
    if (outerSignal?.aborted) throw new Error('ECONNRESET while the leg was in flight');

    for (const [id, controller] of controllers) {
      if (!controller.signal.aborted) continue;
      callbacks.onCancelled?.(id, indexers.find(i => i.id === id)?.name ?? `Indexer-${id}`);
    }

    if (opts.outageAt?.includes(rung)) {
      for (const indexer of indexers) callbacks.onError(indexer.id, indexer.name, 'ECONNREFUSED', 10);
      return [];
    }

    const results = query === opts.hitQuery ? (opts.results ?? []) : [];
    for (const indexer of indexers) {
      callbacks.onComplete(indexer.id, indexer.name, indexer.id === indexers[0]!.id ? results.length : 0, 10);
    }
    return results;
  });

  return {
    service: {
      getEnabledIndexers: vi.fn().mockResolvedValue(indexers),
      searchAllStreaming,
    } as unknown as IndexerSearchService,
    searchAllStreaming,
    entered,
    release: () => open(),
  };
}

/** The signal the route handed the executor, read positionally — presence and identity, not a matcher. */
const outerSignalOf = (fn: ReturnType<typeof vi.fn>, call = 0) =>
  fn.mock.calls[call]![4] as AbortSignal | undefined;

describe('GET /api/search/stream — deadline (#2568)', () => {
  let armed: ArmedDeadlineTimer[];
  let clearTimeoutSpy: MockInstance;

  beforeEach(() => {
    armed = captureDeadlineTimers();
    clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildHandler(overrides: {
    indexerSearchService?: IndexerSearchService;
    blacklistService?: BlacklistService;
    indexerService?: IndexerService;
  } = {}) {
    let handler!: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      {
        get: (_p: string, _o: unknown, h: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => { handler = h; },
        post: vi.fn(),
      } as never,
      overrides.indexerSearchService ?? createMockIndexerSearchService(),
      overrides.blacklistService ?? createMockBlacklistService(),
      createMockSettingsService(),
      overrides.indexerService ?? freshIndexerService(),
      new SearchSessionManager(),
    );
    return handler;
  }

  function streamRequest(query: Record<string, unknown> = { ...DEADLINE_FIXTURE, limit: 50 }) {
    const ctx = createMockReplyAndRequest();
    (ctx.request as { query: Record<string, unknown> }).query = query;
    return ctx;
  }

  const logOf = (request: FastifyRequest, level: 'warn' | 'error') =>
    request.log[level] as unknown as ReturnType<typeof vi.fn>;

  // ── arming ────────────────────────────────────────────────────────────────

  it('arms exactly one deadline timer, at the shared constant, per hijacked request (AC1)', async () => {
    const handler = await buildHandler();
    const { reply, request, hijack } = streamRequest();

    await handler(request, reply);

    expect(hijack).toHaveBeenCalled();
    // captureDeadlineTimers only parks a SEARCH_DEADLINE_MS delay, so a length of 1 is both the
    // cardinality and the constant. An inlined budget, a per-rung arm, or a nested wrap all red.
    expect(armed).toHaveLength(1);
  });

  it.each([
    ['a null bookDuration', { ...DEADLINE_FIXTURE, bookDuration: null }, /bookDuration/],
    ['a parens-only q', { q: '()', limit: 50 }, /empty/i],
    ['a dots-only q', { q: '...', limit: 50 }, /empty/i],
    ['a "?!"-only q (#1904)', { q: '?!', limit: 50 }, /empty/i],
  ])('arms zero timers and keeps today\'s 400 for %s (AC1)', async (_name, query, message) => {
    const handler = await buildHandler();
    const { reply, request, writeHead, hijack } = streamRequest(query as Record<string, unknown>);

    await handler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(message) }));
    expect(writeHead).not.toHaveBeenCalled();
    expect(hijack).not.toHaveBeenCalled();
    expect(armed).toHaveLength(0);
  });

  it('arms zero timers when getEnabledIndexers rejects, because that return precedes the hijack (AC1)', async () => {
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockRejectedValue(new Error('indexer table unavailable')),
      searchAllStreaming: vi.fn(),
    } as unknown as IndexerSearchService;
    const handler = await buildHandler({ indexerSearchService });
    const { reply, request, writeHead, hijack } = streamRequest();

    await expect(handler(request, reply)).rejects.toThrow('indexer table unavailable');

    expect(writeHead).not.toHaveBeenCalled();
    expect(hijack).not.toHaveBeenCalled();
    expect(armed).toHaveLength(0);
  });

  it('hands every rung the same non-aborted signal as searchAllStreaming\'s fifth argument (AC2)', async () => {
    const { service, searchAllStreaming } = streamingService();
    const handler = await buildHandler({ indexerSearchService: service });
    const { reply, request } = streamRequest();

    await handler(request, reply);

    expect(searchAllStreaming).toHaveBeenCalledTimes(DEADLINE_LADDER_RUNGS);
    const signals = searchAllStreaming.mock.calls.map((_c, i) => outerSignalOf(searchAllStreaming, i));
    for (const signal of signals) {
      // Read positionally: a not.objectContaining form cannot separate absent from present-undefined.
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    }
    // One controller for the whole run, so a rung cannot outlive the deadline by getting a fresh one.
    expect(new Set(signals).size).toBe(1);
  });

  it('arms and releases exactly one timer for a zero-indexer run (AC1/AC12)', async () => {
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([]),
      searchAllStreaming: vi.fn().mockResolvedValue([]),
    } as unknown as IndexerSearchService;
    const handler = await buildHandler({ indexerSearchService });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(armed).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]!.handle);
    expect(completeFrame(write)).not.toHaveProperty('timedOut');
  });

  // ── expiry ────────────────────────────────────────────────────────────────

  /** Park rung 1, expire, then release — the only ordering in which the abort is observable. */
  async function runToExpiry(overrides: Partial<StreamingServiceOptions> = {}) {
    const svc = streamingService({ parkAt: 1, ...overrides });
    const indexerService = freshIndexerService();
    const handler = await buildHandler({ indexerSearchService: svc.service, indexerService });
    const ctx = streamRequest();

    const settled = handler(ctx.request, ctx.reply);
    await svc.entered;
    const callsBeforeExpiry = svc.searchAllStreaming.mock.calls.length;

    armed[0]!();
    svc.release();
    await settled;

    return { ...svc, ...ctx, indexerService, callsBeforeExpiry };
  }

  it('ends the ladder at the parked rung and never reaches post-processing (AC3)', async () => {
    const { searchAllStreaming, indexerService, callsBeforeExpiry } = await runToExpiry();

    expect(callsBeforeExpiry).toBe(1);
    // Without the deadline this fixture runs DEADLINE_LADDER_RUNGS rungs, so the freeze is real.
    expect(searchAllStreaming).toHaveBeenCalledTimes(1);
    expect(indexerService.getLanAllowlist).not.toHaveBeenCalled();
  });

  it('aborts the very signal it handed the executor (AC2/AC3)', async () => {
    const { searchAllStreaming } = await runToExpiry();

    expect(outerSignalOf(searchAllStreaming)!.aborted).toBe(true);
  });

  it('discloses the expiry on the terminal payload instead of spelling it as a genuine zero (AC4)', async () => {
    const { write } = await runToExpiry();

    expect(completeFrame(write)).toEqual({
      results: [],
      durationUnknown: true,
      unsupportedResults: { count: 0, titles: [] },
      timedOut: true,
    });
    expect(completeFrame(write)).not.toHaveProperty('relaxedQuery');
    // No sixth event name reaches the wire; the flag rides the payload the client already validates.
    expect(namedFrames(write).map(f => f.event)).toEqual(['search-start', 'search-complete']);
  });

  it('does not blame the indexers for a leg the deadline tore (AC8)', async () => {
    const { write, indexerService } = await runToExpiry();

    const events = namedFrames(write).map(f => f.event);
    expect(events).not.toContain('indexer-cancelled');
    expect(events).not.toContain('indexer-error');
    expect(indexerService.recordSearchFailure).not.toHaveBeenCalled();
  });

  it('logs the expiry once, at warn, under its own pinned message with a sibling budgetMs (AC9)', async () => {
    const { request } = await runToExpiry();

    expect(logOf(request, 'error')).not.toHaveBeenCalled();
    expect(logOf(request, 'warn')).toHaveBeenCalledTimes(1);

    const [payload, message] = logOf(request, 'warn').mock.calls[0]! as [Record<string, unknown>, string];
    // The literal itself, not merely "differs from 'Search stream error'": inequality with one line
    // does not stop an implementation from reusing another surface's wording.
    expect(message).toBe('Search stream deadline exceeded');
    // A sibling, because serializeError emits a fixed key set that would drop it.
    expect(payload.budgetMs).toBe(SEARCH_DEADLINE_MS);
    // objectContaining/toMatchObject read through to Error.prototype; the own-key set does not.
    expect(payload.error).not.toBeInstanceOf(Error);
    expect(Object.keys(payload.error as object).sort()).toEqual(['message', 'stack', 'type']);
  });

  it('releases the timer on a normal completion, and a re-fire writes nothing further (AC10)', async () => {
    const handler = await buildHandler();
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(armed).toHaveLength(1);
    expect(armed[0]!.unrefCount).toBeGreaterThan(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]!.handle);
    const framesBefore = write.mock.calls.length;
    armed[0]!();
    expect(write.mock.calls).toHaveLength(framesBefore);
  });

  it('releases the timer on an expiry, and a re-fire writes nothing further (AC10)', async () => {
    const { write } = await runToExpiry();

    expect(armed[0]!.unrefCount).toBeGreaterThan(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]!.handle);
    const framesBefore = write.mock.calls.length;
    armed[0]!();
    expect(write.mock.calls).toHaveLength(framesBefore);
  });

  it('releases the timer on a non-deadline rejection (AC10)', async () => {
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }]),
      searchAllStreaming: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as IndexerSearchService;
    const handler = await buildHandler({ indexerSearchService });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(armed[0]!.unrefCount).toBeGreaterThan(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]!.handle);
    const framesBefore = write.mock.calls.length;
    armed[0]!();
    expect(write.mock.calls).toHaveLength(framesBefore);
  });

  it('releases the timer when the client disconnects mid-search (AC10)', async () => {
    const svc = streamingService({ parkAt: 1 });
    const handler = await buildHandler({ indexerSearchService: svc.service });
    const { reply, request, write, onClose } = streamRequest();

    const settled = handler(request, reply);
    await svc.entered;

    const closeHandler = onClose.mock.calls[0]![1] as () => void;
    closeHandler();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]!.handle);
    const framesBefore = write.mock.calls.length;
    armed[0]!();
    expect(write.mock.calls).toHaveLength(framesBefore);

    svc.release();
    await settled;
  });

  // ── discrimination: the control cases that give the expiry cases their meaning ──

  it('leaves timedOut off a genuine answered zero across every rung (AC4/AC6 control)', async () => {
    const { service, searchAllStreaming } = streamingService();
    const handler = await buildHandler({ indexerSearchService: service });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(searchAllStreaming).toHaveBeenCalledTimes(DEADLINE_LADDER_RUNGS);
    expect(completeFrame(write)!.results).toEqual([]);
    expect(completeFrame(write)).not.toHaveProperty('timedOut');
  });

  it('leaves timedOut off a total indexer outage (AC4/AC6 control)', async () => {
    const { service, searchAllStreaming } = streamingService({ outageAt: [2] });
    const handler = await buildHandler({ indexerSearchService: service });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(searchAllStreaming).toHaveBeenCalledTimes(2);
    expect(completeFrame(write)!.results).toEqual([]);
    expect(completeFrame(write)).not.toHaveProperty('timedOut');
  });

  it('leaves timedOut off a non-deadline rejection and keeps today\'s error log (AC6)', async () => {
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'AudioBookBay' }]),
      searchAllStreaming: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as IndexerSearchService;
    const handler = await buildHandler({ indexerSearchService });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(completeFrame(write)).toEqual({
      results: [],
      durationUnknown: true,
      unsupportedResults: { count: 0, titles: [] },
    });
    expect(completeFrame(write)).not.toHaveProperty('timedOut');
    expect(logOf(request, 'warn')).not.toHaveBeenCalled();
    expect(logOf(request, 'error')).toHaveBeenCalledTimes(1);
    expect(logOf(request, 'error').mock.calls[0]![1]).toBe('Search stream error');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('does not falsify a good answer when the timer fires during post-processing (AC7)', async () => {
    const { service } = streamingService({
      hitQuery: DEADLINE_FIXTURE.q,
      results: [survivingResult({ infoHash: 'a'.repeat(40) })],
    });

    // getLanAllowlist is the cleanest seam in post-processing that the deadline cannot tear — it
    // takes no signal even after #2573, which bounded only the enrichment tail below it. This is the
    // case that separates "attach timedOut in the catch" from "attach it whenever `expired`" — the
    // latter passes the AC4 case and reds only here.
    let openAllowlist!: () => void;
    const allowlistParked = new Promise<void>((resolve) => { openAllowlist = resolve; });
    let allowlistEntered!: () => void;
    const enteredAllowlist = new Promise<void>((resolve) => { allowlistEntered = resolve; });
    const indexerService = freshIndexerService();
    indexerService.getLanAllowlist.mockImplementation(async () => {
      allowlistEntered();
      await allowlistParked;
      return { hostPort: new Set<string>(), hostname: new Set<string>() };
    });

    const handler = await buildHandler({ indexerSearchService: service, indexerService });
    const { reply, request, write } = streamRequest();

    const settled = handler(request, reply);
    await enteredAllowlist;
    armed[0]!();
    openAllowlist();
    await settled;

    const complete = completeFrame(write)!;
    expect((complete.results as Array<{ title: string }>).map(r => r.title)).toEqual(['The Churn']);
    expect(complete).not.toHaveProperty('timedOut');
    expect(logOf(request, 'warn')).not.toHaveBeenCalled();
  });

  it('keeps the catch un-widened when post-processing itself rejects (AC6)', async () => {
    const { service } = streamingService({
      hitQuery: DEADLINE_FIXTURE.q,
      results: [survivingResult({ infoHash: 'b'.repeat(40) })],
    });
    const blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockRejectedValue(new Error('blacklist table locked')),
    } as unknown as BlacklistService;

    const handler = await buildHandler({ indexerSearchService: service, blacklistService });
    const { reply, request, write } = streamRequest();

    await handler(request, reply);

    expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalled();
    expect(completeFrame(write)).toEqual({
      results: [],
      durationUnknown: true,
      unsupportedResults: { count: 0, titles: [] },
    });
    expect(logOf(request, 'error').mock.calls[0]![1]).toBe('Search stream error');
    expect(logOf(request, 'warn')).not.toHaveBeenCalled();
    expect(reply.raw.end).toHaveBeenCalled();
  });

  // ── #2573: the post-processing tail is bounded by the same controller ──────
  describe('the enrichment tail is bounded by the deadline (#2573)', () => {
    /** Mirrors NZB_FETCH_CONCURRENCY: the wave that is already on the wire when the abort lands. */
    const WAVE = 5;
    const mockNzbFetch = vi.mocked(fetchWithSsrfRedirect);

    const PLAIN_NZB = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
      <file poster="t" date="1" subject="Plain English Audiobook MP3">
        <groups><group>alt.binaries.audiobooks</group></groups>
        <segments><segment bytes="1" number="1">id@e</segment></segments>
      </file>
    </nzb>`;

    /** Usenet counterpart to `survivingResult`: a downloadUrl and no language is what reaches phase 2. */
    const usenetCandidate = (tag: string, i: number) => ({
      title: 'The Churn',
      protocol: 'usenet',
      indexer: 'Newznab',
      indexerId: 2,
      guid: `${tag}-${i}`,
      downloadUrl: `http://nzb.test/${tag}-${i}`,
      size: 500 * 1024 * 1024,
      seeders: 10,
      grabs: 10,
    });

    const candidates = (tag: string, n: number) => Array.from({ length: n }, (_, i) => usenetCandidate(tag, i));

    beforeEach(() => {
      // Process-wide, so a warm entry from a sibling case would silently remove a fetch.
      enrichmentCache.clear();
      mockNzbFetch.mockReset();
      vi.mocked(createSsrfSafeDispatcher).mockImplementation(
        () => ({ close: vi.fn().mockResolvedValue(undefined) }) as never,
      );
    });

    /**
     * Parks every NZB fetch and reports when `WAVE` of them are genuinely on the wire — the only
     * window in which the abort reaches a queued waiter rather than the pre-acquire guard.
     */
    function parkNzbFetches() {
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => { open = resolve; });
      let admit!: () => void;
      const onWire = new Promise<void>((resolve) => { admit = resolve; });
      let started = 0;
      mockNzbFetch.mockImplementation(async () => {
        if (++started >= WAVE) admit();
        await barrier;
        return new Response(PLAIN_NZB, { status: 200 });
      });
      return { onWire, release: () => open() };
    }

    it('does not falsify a good answer when the timer fires during enrichment (AC11)', async () => {
      const { service } = streamingService({ hitQuery: DEADLINE_FIXTURE.q, results: candidates('ac11', 12) });
      const { onWire, release } = parkNzbFetches();
      const handler = await buildHandler({ indexerSearchService: service });
      const { reply, request, write } = streamRequest();

      const settled = handler(request, reply);
      await onWire;
      armed[0]!();
      release();
      await settled;

      // Reds if enrichment rethrows on abort: the run would route into the `expired` catch, which
      // replaces these twelve real results with `[]` and `timedOut: true`.
      const complete = completeFrame(write)!;
      expect(complete.results as unknown[]).toHaveLength(12);
      expect(complete).not.toHaveProperty('timedOut');
      expect(logOf(request, 'error')).not.toHaveBeenCalled();
      expect(reply.raw.end).toHaveBeenCalled();
      // The expiry is disclosed in the log and nowhere else (AC4/AC7): the truncation line fires,
      // the deadline-exceeded line — which only the failure arm writes — does not.
      expect(logOf(request, 'warn').mock.calls.map((c) => c[1]))
        .toEqual(['Usenet enrichment truncated by abort']);
      expect(logOf(request, 'warn').mock.calls[0]![0]).toMatchObject({ abortSkipped: 7, nzbFetched: WAVE });
    });

    it.each([8, 20])('collapses the tail to one wave at %i candidates, so it no longer grows with N', async (n) => {
      const { service } = streamingService({ hitQuery: DEADLINE_FIXTURE.q, results: candidates(`n${n}`, n) });
      const { onWire, release } = parkNzbFetches();
      const handler = await buildHandler({ indexerSearchService: service });
      const { reply, request } = streamRequest();

      const settled = handler(request, reply);
      await onWire;
      const atAbort = mockNzbFetch.mock.calls.length;
      armed[0]!();
      release();
      await settled;

      // The delta is the property: a bare total is satisfiable by a run that never got that far.
      // Identical at 8 and at 20 is what separates "some fetches were skipped" from "the tail is
      // constant in N". No elapsed-time claim belongs here — the mock stands in for up to
      // MAX_REDIRECTS + 1 real hops plus un-timed DNS, pinned upstream in network-service.test.ts.
      expect(atAbort).toBe(WAVE);
      expect(mockNzbFetch.mock.calls.length - atAbort).toBe(0);
    });

    it('hands enrichment the very signal the ladder received, not a second controller (AC9)', async () => {
      mockNzbFetch.mockImplementation(async () => new Response(PLAIN_NZB, { status: 200 }));
      const enrichSpy = vi.spyOn(enrichModule, 'enrichUsenetLanguages');
      const { service, searchAllStreaming } = streamingService({ hitQuery: DEADLINE_FIXTURE.q, results: candidates('same', 3) });
      const handler = await buildHandler({ indexerSearchService: service });
      const { reply, request } = streamRequest();

      await handler(request, reply);

      const options = enrichSpy.mock.calls[0]![3]!;
      expect(options.signal).toBe(outerSignalOf(searchAllStreaming));
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('leaves a non-expiring run fully enriched and uncapped (AC12 parity)', async () => {
      mockNzbFetch.mockImplementation(async () => new Response(PLAIN_NZB, { status: 200 }));
      const enrichSpy = vi.spyOn(enrichModule, 'enrichUsenetLanguages');
      const { service } = streamingService({ hitQuery: DEADLINE_FIXTURE.q, results: candidates('parity', 12) });
      const handler = await buildHandler({ indexerSearchService: service });
      const { reply, request, write } = streamRequest();

      await handler(request, reply);

      // Uncapped: every candidate is fetched however many there are (#1315/#1330 unchanged).
      expect(mockNzbFetch).toHaveBeenCalledTimes(12);
      expect(enrichSpy.mock.calls[0]![3]).not.toHaveProperty('maxPhase2Fetches');
      const complete = completeFrame(write)!;
      expect(complete.results as unknown[]).toHaveLength(12);
      expect(complete).not.toHaveProperty('timedOut');
      expect(logOf(request, 'warn')).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/search/stream — deadline over real HTTP (#2568)', () => {
  let armed: ArmedDeadlineTimer[];

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    armed = captureDeadlineTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  const url = (params: Record<string, string>) =>
    `/api/search/stream?${new URLSearchParams({ token: STREAM_TOKEN, ...params }).toString()}`;

  it('carries the expiry to the wire as one timed-out search-complete and nothing else (AC3/AC4/AC8)', async () => {
    const svc = streamingService({ parkAt: 1 });
    const app = await buildApp(svc.service, { indexerService: freshIndexerService() });
    try {
      const pending = fetchSseEvents(app, url({ q: DEADLINE_FIXTURE.q, title: DEADLINE_FIXTURE.title, author: DEADLINE_FIXTURE.author }));
      await svc.entered;
      armed[0]!();
      svc.release();

      const { status, events } = await pending;

      expect(status).toBe(200);
      expect(events.filter(e => e.event !== 'hb').map(e => e.event)).toEqual(['search-start', 'search-complete']);
      expect(events.find(e => e.event === 'search-complete')!.data).toEqual({
        results: [],
        durationUnknown: true,
        unsupportedResults: { count: 0, titles: [] },
        timedOut: true,
      });
      expect(svc.searchAllStreaming).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('runs two concurrent streams for the same query independently — no collision gate either way (AC11)', async () => {
    const svc = streamingService();
    const app = await buildApp(svc.service, { indexerService: freshIndexerService() });
    const target = url({ q: DEADLINE_FIXTURE.q, title: DEADLINE_FIXTURE.title, author: DEADLINE_FIXTURE.author });

    try {
      // Listen once up front so the two concurrent fetches cannot race on the helper's lazy bind.
      await app.listen({ port: 0, host: '127.0.0.1' });
      const [a, b] = await Promise.all([fetchSseEvents(app, target), fetchSseEvents(app, target)]);

      for (const result of [a, b]) {
        expect(result.events.find(e => e.event === 'search-complete')!.data).toMatchObject({ results: [] });
        expect(result.events.some(e => e.event === 'indexer-error')).toBe(false);
      }
      // Both ladders ran in full: neither stream refused, joined, or truncated the other.
      expect(svc.searchAllStreaming).toHaveBeenCalledTimes(DEADLINE_LADDER_RUNGS * 2);
    } finally {
      await app.close();
    }
  });

  /**
   * `inFlightSearches` is module-level state shared with other suites, so this asserts the DELTA
   * across its own action. The case deliberately makes this the third route-directory TEST file
   * naming the registry helpers — a test exercising the real registry from outside is not a
   * registration, which is exactly why AC11's grep is scoped to production modules.
   */
  it('is neither gated by nor visible to a registered in-flight search for the same book (AC11)', async () => {
    const BOOK_ID = 4242;
    const svc = streamingService();
    const app = await buildApp(svc.service, { indexerService: freshIndexerService() });
    const log = { debug: vi.fn(), warn: vi.fn() } as never;

    let releaseRegistered!: () => void;
    const registered = withSearchDeadline(
      { budgetMs: SEARCH_DEADLINE_MS, bookId: BOOK_ID, log },
      () => new Promise<null>((resolve) => { releaseRegistered = () => resolve(null); }),
    );

    try {
      // The registered operation is still held; a registry member would refuse or queue here.
      const { events } = await fetchSseEvents(app, url({
        q: DEADLINE_FIXTURE.q, title: DEADLINE_FIXTURE.title, author: DEADLINE_FIXTURE.author,
      }));

      expect(svc.searchAllStreaming).toHaveBeenCalledTimes(DEADLINE_LADDER_RUNGS);
      expect(events.find(e => e.event === 'search-complete')!.data).toMatchObject({ results: [] });
      // And the stream registered nothing of its own: the held slot is still the only member, so
      // the same book is still refusable — proof the route did not join and did not evict.
      expect(await withSearchDeadline({ budgetMs: SEARCH_DEADLINE_MS, bookId: BOOK_ID, log }, async () => 'ran')).toBeNull();
    } finally {
      releaseRegistered();
      await registered;
      await app.close();
    }
  });
});
