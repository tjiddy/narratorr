import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SearchSessionManager } from '../services/search-session.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';

// Mock the search pipeline
vi.mock('../services/search-pipeline.js', () => ({
  filterAndRankResults: vi.fn().mockReturnValue({
    results: [],
    durationUnknown: false,
  }),
}));

import { filterAndRankResults } from '../services/search-pipeline.js';

function createMockReplyAndRequest(query = 'test+query') {
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
      const mockRanked = {
        results: [{ title: 'Book', indexer: 'test' }],
        durationUnknown: true,
      };
      (filterAndRankResults as ReturnType<typeof vi.fn>).mockReturnValue(mockRanked);

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
});
