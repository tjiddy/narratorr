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
import { fetchSseEvents } from '../__tests__/sse-helpers.js';
import { HEARTBEAT_INTERVAL_MS } from '../utils/sse-stream.js';

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
      // Configure mock to simulate indexer list via searchAllStreaming
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, _cb: unknown) => [],
      );

      const { reply, request, write } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      // search-start is written before searchAllStreaming is called
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

    it('registers close handler for client disconnect cleanup', async () => {
      const { reply, request, onClose } = createMockReplyAndRequest();
      await streamHandler!(request, reply);

      // Verify onClose was registered to handle client disconnects
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
      // Make searchAllStreaming hang so the close handler fires mid-search
      let resolveSearch: (v: never[]) => void;
      indexerService.searchAllStreaming = vi.fn().mockImplementation(
        () => new Promise<never[]>((resolve) => { resolveSearch = resolve; }),
      );

      const { reply, request, onClose } = createMockReplyAndRequest();
      // Start handler (it will await the hanging search)
      const handlerPromise = streamHandler!(request, reply);
      // Flush microtask queue so the handler reaches the await on searchAllStreaming
      await new Promise(resolve => setTimeout(resolve, 0));

      // Extract session ID from the search-start event that was already written
      const writeCall = (reply.raw.write as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('event: search-start'),
      );
      const dataLine = (writeCall![0] as string).split('\n').find((l: string) => l.startsWith('data: '));
      const data = JSON.parse(dataLine!.replace('data: ', ''));
      const sid = data.sessionId as string;

      // Session exists while search is in-flight
      expect(sessionManager.get(sid)).toBeDefined();
      const session = sessionManager.get(sid)!;

      // Simulate client disconnect (fires before search completes)
      const closeHandler = onClose.mock.calls[0]![1] as () => void;
      closeHandler();

      // Session removed and controllers aborted by the close callback
      expect(sessionManager.get(sid)).toBeUndefined();
      for (const [, controller] of session.controllers) {
        expect(controller.signal.aborted).toBe(true);
      }

      // Let the search resolve so the handler completes cleanly
      resolveSearch!([] as never[]);
      await handlerPromise;
    });
  });

  // #1799 — keep the stream warm with named `hb` heartbeat frames while the search is in flight
  // so a slow indexer doesn't idle the connection into a reverse-proxy cut.
  describe('in-flight heartbeat', () => {
    // Fake only the interval timers so real setTimeout(0) can still flush the
    // microtask queue between the handler's awaits (vitest-faketimers-react-query).
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

    // Real setTimeout(0) — flushes pending microtasks so the handler reaches its await.
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

      // No further heartbeats after the finally cleared the timer.
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

      // A throw inside the setInterval callback would have no caller and crash the process.
      expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)).not.toThrow();

      // The guard stopped the timer after the first failure — no repeated attempts.
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

  // #1453 — the SSE/cancel routes are no longer API-key-reachable. Streams
  // authenticate via a short-lived stream token (`?token=`); the cancel route
  // (a plain POST) authenticates via the ambient non-key chain (here, a forms
  // session cookie).
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

    // Create a session so cancel has something to target
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
    // app.inject() hangs on hijacked SSE responses (per fastify-sse-hijack-testing learning),
    // so use fetchSseEvents() to test the full Fastify stack over real HTTP. Auth is via
    // the #1453 stream token (`?token=`), not the API key.
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

      // Auth accepted — 200 with SSE headers
      expect(status).toBe(200);
      expect(headers.get('content-type')).toBe('text/event-stream');
      expect(headers.get('cache-control')).toBe('no-cache');

      // Should contain search-start with empty indexer list
      const startEvent = events.find(e => e.event === 'search-start');
      expect(startEvent).toBeDefined();
      const startData = startEvent!.data as { sessionId: string; indexers: unknown[] };
      expect(startData.sessionId).toBeDefined();
      expect(startData.indexers).toEqual([]);

      // Should contain search-complete with empty SearchResponse
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

  // #1453 — cancel route (a plain POST, not hijacked) is fully inject-testable.
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

// ============================================================================
// #2104 — progressive query relaxation on the interactive surface
// ============================================================================

describe('GET /api/search/stream — query ladder (#2104)', () => {
  const VALID_STREAM_TOKEN = 'valid-stream-token';
  const BOOK_TITLE = 'The Churn: An Expanse Novella';
  const AUTHOR = 'James S. A. Corey';
  const CANONICAL_Q = 'The Churn An Expanse Novella James S A Corey';

  /** Every rung the ladder builds for this book, in order. */
  const RUNGS = [
    CANONICAL_Q,
    'the churn James S A Corey',
    'an expanse novella James S A Corey',
    'the churn an expanse novella',
    'the churn',
    'an expanse novella',
  ];

  function authService(): AuthService {
    return {
      validateApiKey: vi.fn().mockResolvedValue(true),
      getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
      verifyStreamToken: vi.fn().mockImplementation((token: string) =>
        token === VALID_STREAM_TOKEN ? { kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } : null),
      verifySessionCookie: vi.fn().mockReturnValue(null),
      getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      hasUser: vi.fn().mockResolvedValue(true),
    } as unknown as AuthService;
  }

  async function buildApp(indexerSearchService: IndexerSearchService) {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService: authService() });
    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      indexerSearchService,
      createMockBlacklistService(),
      createMockSettingsService(),
      mockIndexer,
      new SearchSessionManager(),
    );
    return app;
  }

  /**
   * Streaming search whose per-indexer answer depends on the transport query.
   * `onComplete` is what increments the ladder's `succeeded` count, so a rung
   * that reports completions with zero results is a GENUINE zero and advances.
   */
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
    // Echo the winning rung's results through, so `search-complete` carries the
    // ladder's output rather than a fixed empty payload.
    postProcessSpy = vi.spyOn(searchPipeline, 'postProcessSearchResults')
      .mockImplementation(async (results) => ({ results, durationUnknown: false, unsupportedResults: { count: 0, titles: [] } }));
  });
  afterEach(() => postProcessSpy.mockRestore());

  // AC24 — rung 1 is the query the user asked for, so there is nothing to tell
  // them. The key must be ABSENT, not present-and-undefined.
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

  // AC24 — a relaxed winning rung is disclosed verbatim.
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

  // AC24 / F1 — a ladder that RAN a relaxed rung is not a ladder that MATCHED on
  // one. `runQueryLadder` reports the last rung it attempted, so exhaustion and a
  // later-rung outage both surface an index > 0 with an empty result set. Keying
  // disclosure on the index alone would put "matched on relaxed query" next to
  // "No releases found".
  it('omits relaxedQuery when the ladder exhausts every rung at zero (AC24, F1)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      const { events } = await fetchSseEvents(app, url({ q: CANONICAL_Q, title: BOOK_TITLE, author: AUTHOR }));
      const complete = events.find((e) => e.event === 'search-complete')!;

      // The ladder really did reach a relaxed rung — this is not a rung-1 case.
      expect(queriesOf(service)).toEqual(RUNGS);
      expect((complete.data as { results: unknown[] }).results).toEqual([]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  // AC24 / F1 — the outage arm. A later rung where NO indexer answered aborts the
  // ladder, returning that rung with an empty set; it produced nothing, so there
  // is nothing to disclose.
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
          // Rung 1 answers a genuine zero; rung 2 finds every indexer down.
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

      // Aborted at rung 2 — an index > 0, so an index-only condition would fire.
      expect(queriesOf(service)).toEqual(RUNGS.slice(0, 2));
      expect((complete.data as { results: unknown[] }).results).toEqual([]);
      expect(complete.data as Record<string, unknown>).not.toHaveProperty('relaxedQuery');
    } finally {
      await app.close();
    }
  });

  // AC24 / F1 — the third arm the index-only condition also got wrong: a relaxed
  // rung DID return releases, but the existing blacklist/quality/language gates
  // removed all of them. The notice sits above the result list and explains it,
  // so with nothing listed it explains nothing and contradicts "No releases found".
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

  // #2133 AC11 — discovery applies NO corroboration floor, and must not start.
  // The modal is correct today: it lists the franchise siblings and lets a
  // person make the call. The very rung whose auto-grab #2133 now HOLDS still
  // surfaces every one of them here, with no hold and no held event.
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

  // AC26 — per-indexer counts need NO buffering: the client replaces its entry
  // by `indexerId`, so the LAST frame per indexer is the winning rung's.
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

  // AC27 — sticky cancellation. `SearchSessionManager` keeps one controller map
  // for the session; the route hands the SAME map to every rung, which is what
  // lets `searchAllStreaming`'s pre-adapter guard skip a cancelled indexer.
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
            // Stand-in for the real pre-adapter abort guard: already-cancelled
            // indexers are skipped with NO callback at all.
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

      // Indexer 1 is queried on rung 1 and never again.
      expect(queriedIndexers[0]).toEqual([1, 2]);
      expect(queriedIndexers.slice(1).every((ids) => ids.every((id) => id !== 1))).toBe(true);
      // COUNTERFACTUAL: build a fresh controller map per rung and indexer 1 is
      // re-queried on every rung, emitting a duplicate frame each time.
      expect(cancelledFrames).toEqual([1]);
    } finally {
      await app.close();
    }
  });

  // AC38 — with no canonical title there is nothing to relax, and inventing one
  // from the free-text `q` would relax a string the user typed.
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

  // D13 — the pre-SSE empty-clean guard is deliberately PRESERVED. The user
  // explicitly typed that query; silently searching for the canonical title
  // instead is worse than telling them their input is unusable.
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

  // D13 — an EDITED query is rung 1 verbatim; only the relaxed rungs come from
  // the canonical title.
  it('uses the user-edited q verbatim as rung 1 while relaxing the canonical title (D13)', async () => {
    const { service } = serviceAnswering(null);
    const app = await buildApp(service);
    try {
      await fetchSseEvents(app, url({ q: 'churn expanse', title: BOOK_TITLE, author: AUTHOR }));

      // The canonical `full` variant no longer collapses onto rung 1 (the
      // edited query is a different search), so it takes its own rung — the
      // surprising case is bounded to "user edited, got zero, saw canonical
      // relaxations".
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
