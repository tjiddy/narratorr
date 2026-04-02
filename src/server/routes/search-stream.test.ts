import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { SearchSessionManager } from '../services/search-session.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { AuthService } from '../services/auth.service.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import authPlugin from '../plugins/auth.js';

// Mock the search pipeline
vi.mock('../services/search-pipeline.js', () => ({
  postProcessSearchResults: vi.fn().mockResolvedValue({
    results: [],
    durationUnknown: false,
    unsupportedResults: { count: 0, titles: [] },
  }),
}));

import { postProcessSearchResults } from '../services/search-pipeline.js';

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

function createMockIndexerService(results: Array<{ indexerId: number; results: Array<Record<string, unknown>> }> = []) {
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
  } as unknown as IndexerService;
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

describe('searchStreamRoutes', () => {
  let sessionManager: SearchSessionManager;
  let indexerService: ReturnType<typeof createMockIndexerService>;
  let blacklistService: ReturnType<typeof createMockBlacklistService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let streamHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null;
  let cancelHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionManager = new SearchSessionManager();
    indexerService = createMockIndexerService();
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
      sessionManager,
    );
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
      (postProcessSearchResults as ReturnType<typeof vi.fn>).mockResolvedValue(mockProcessed);

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
      const closeHandler = onClose.mock.calls[0][1] as () => void;
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
});

vi.mock('../config.js', () => ({
  config: { authBypass: false, isDev: true },
}));

describe('searchStreamRoutes — app.inject() integration', () => {
  function createMockAuthService(valid = false) {
    return {
      validateApiKey: vi.fn().mockResolvedValue(valid),
      getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      hasUser: vi.fn().mockResolvedValue(true),
    } as unknown as AuthService;
  }

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
      createMockIndexerService(),
      createMockBlacklistService(),
      createMockSettingsService(),
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
      createMockIndexerService(),
      createMockBlacklistService(),
      createMockSettingsService(),
      sessionMgr,
    );
    await app.ready();

    // Create a session so cancel has something to target
    const session = sessionMgr.create([{ id: 1, name: 'Test' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/search/stream/${session.sessionId}/cancel/1?apikey=valid-key`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cancelled: true });

    await app.close();
  });

  it('successful GET with valid apikey and zero indexers returns SSE stream with empty results', async () => {
    // app.inject() hangs on hijacked SSE responses (per fastify-sse-hijack-testing learning),
    // so use app.listen(0) + real HTTP fetch to test the full Fastify stack.
    // Reset the shared mock to return empty results for zero-indexer case
    (postProcessSearchResults as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    });

    const authService = createMockAuthService(true);
    const zeroIndexerService = {
      ...createMockIndexerService(),
      getEnabledIndexers: vi.fn().mockResolvedValue([]),
      searchAllStreaming: vi.fn().mockResolvedValue([]),
    } as unknown as IndexerService;

    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });

    const { searchStreamRoutes } = await import('./search-stream.js');
    await searchStreamRoutes(
      app,
      zeroIndexerService,
      createMockBlacklistService(),
      createMockSettingsService(),
      new SearchSessionManager(),
    );

    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const res = await fetch(`${address}/api/search/stream?q=test&apikey=valid-key`);

      // Auth accepted — 200 with SSE headers
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');

      // Read the full SSE body
      const body = await res.text();

      // Should contain search-start with empty indexer list
      expect(body).toContain('event: search-start');
      const searchStartMatch = body.match(/event: search-start\ndata: (.+)\n/);
      expect(searchStartMatch).not.toBeNull();
      const startData = JSON.parse(searchStartMatch![1]);
      expect(startData.sessionId).toBeDefined();
      expect(startData.indexers).toEqual([]);

      // Should contain search-complete with empty SearchResponse
      expect(body).toContain('event: search-complete');
      const searchCompleteMatch = body.match(/event: search-complete\ndata: (.+)\n/);
      expect(searchCompleteMatch).not.toBeNull();
      const completeData = JSON.parse(searchCompleteMatch![1]);
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
      createMockIndexerService(),
      createMockBlacklistService(),
      createMockSettingsService(),
      new SearchSessionManager(),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search/stream/nonexistent/cancel/1?apikey=valid-key',
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
