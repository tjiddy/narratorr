/**
 * Integration tests for reject word filtering on the SSE search-stream endpoint.
 *
 * Unlike search-stream.test.ts (which mocks postProcessSearchResults at module scope),
 * this file does NOT mock the search pipeline — the real postProcessSearchResults runs,
 * proving that reject word filtering works end-to-end through the SSE path.
 *
 * Uses fetchSseEvents() (real HTTP via app.listen(0)) because app.inject() hangs on SSE hijacked responses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { SearchSessionManager } from '../services/search-session.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { AuthService } from '../services/auth.service.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import authPlugin from '../plugins/auth.js';
import { searchStreamRoutes } from './search-stream.js';
import type { SearchResult } from '../../core/index.js';
import { fetchSseEvents } from '../__tests__/sse-helpers.js';

type SearchCompleteData = {
  results: SearchResult[];
  durationUnknown: boolean;
  unsupportedResults: { count: number; titles: string[] };
};

function getSearchComplete(events: Array<{ event: string; data: unknown }>): SearchCompleteData {
  const event = events.find(e => e.event === 'search-complete');
  expect(event).toBeDefined();
  return event!.data as SearchCompleteData;
}

vi.mock('../config.js', () => ({
  config: { authBypass: false, isDev: true },
}));

const baseResult: SearchResult = {
  title: 'The Way of Kings',
  protocol: 'torrent' as const,
  indexer: 'AudioBookBay',
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 1073741824,
  seeders: 42,
};

function createMockAuthService() {
  return {
    validateApiKey: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
    hasUser: vi.fn().mockResolvedValue(true),
  } as unknown as AuthService;
}

function createMockIndexerSearchService(rawResults: SearchResult[] = []) {
  return {
    getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'TestIndexer' }]),
    searchAllStreaming: vi.fn().mockImplementation(
      async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: {
        onComplete: (indexerId: number, name: string, resultCount: number, elapsedMs: number) => void;
      }) => {
        callbacks.onComplete(1, 'TestIndexer', rawResults.length, 50);
        return rawResults;
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

function createMockSettingsService(qualityOverrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockImplementation((category: string) => {
      if (category === 'quality') {
        return Promise.resolve({ ...DEFAULT_SETTINGS.quality, ...qualityOverrides });
      }
      return Promise.resolve(DEFAULT_SETTINGS[category as keyof typeof DEFAULT_SETTINGS]);
    }),
  } as unknown as SettingsService;
}

async function createApp(rawResults: SearchResult[], qualityOverrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(authPlugin, { authService: createMockAuthService() });

  await searchStreamRoutes(
    app,
    createMockIndexerSearchService(rawResults),
    createMockBlacklistService(),
    createMockSettingsService(qualityOverrides),
    new SearchSessionManager(),
  );

  return { app };
}

describe('searchStreamRoutes — reject word filtering (real postProcessSearchResults)', () => {
  let appInstance: Awaited<ReturnType<typeof createApp>>['app'] | null = null;

  afterEach(async () => {
    if (appInstance) {
      await appInstance.close();
      appInstance = null;
    }
  });

  describe('reject words from quality settings', () => {
    it('filters results matching reject words from search-complete SSE event', async () => {
      const results = [
        { ...baseResult, title: 'GraphicAudio Edition' },
        { ...baseResult, title: 'English Edition' },
      ];
      const { app } = await createApp(results, { rejectWords: 'graphicaudio' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('English Edition');
    });

    it('applies case-insensitive matching against reject words', async () => {
      const results = [
        { ...baseResult, title: 'GraphicAudio Edition' },
        { ...baseResult, title: 'Clean Edition' },
      ];
      const { app } = await createApp(results, { rejectWords: 'GRAPHICAUDIO' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('Clean Edition');
    });

    it('filters by rawTitle when rawTitle is present', async () => {
      const results = [
        { ...baseResult, title: 'Clean Title', rawTitle: 'Rejected.Version.GraphicAudio' },
        { ...baseResult, title: 'Another Clean' },
      ];
      const { app } = await createApp(results, { rejectWords: 'graphicaudio' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('Another Clean');
    });

    it('filters results matching any of multiple comma-separated reject words', async () => {
      const results = [
        { ...baseResult, title: 'German Edition' },
        { ...baseResult, title: 'GraphicAudio Version' },
        { ...baseResult, title: 'English Edition' },
      ];
      const { app } = await createApp(results, { rejectWords: 'german, graphicaudio' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('English Edition');
    });

    it('filters results by substring match', async () => {
      const results = [
        { ...baseResult, title: 'German Unabridged' },
        { ...baseResult, title: 'English Edition' },
      ];
      const { app } = await createApp(results, { rejectWords: 'german' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('English Edition');
    });

    it('returns all results unfiltered when reject words setting is empty', async () => {
      const results = [
        { ...baseResult, title: 'Book One' },
        { ...baseResult, title: 'Book Two' },
      ];
      const { app } = await createApp(results, { rejectWords: '' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(2);
    });

    it('returns empty results array when all results match reject words', async () => {
      const results = [
        { ...baseResult, title: 'German Edition' },
        { ...baseResult, title: 'German Audiobook' },
      ];
      const { app } = await createApp(results, { rejectWords: 'german' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(0);
    });
  });

  describe('boundary values', () => {
    it('ignores whitespace-only entries in reject words list', async () => {
      const results = [
        { ...baseResult, title: 'German Edition' },
        { ...baseResult, title: 'English Edition' },
      ];
      const { app } = await createApp(results, { rejectWords: '  , , german' });
      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.title).toBe('English Edition');
    });
  });

  describe('error isolation', () => {
    it('emits search-complete with empty results when postProcessSearchResults throws', async () => {
      // Force settings service to throw, which makes postProcessSearchResults throw
      const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(cookie);
      await app.register(authPlugin, { authService: createMockAuthService() });

      const throwingSettingsService = {
        get: vi.fn().mockRejectedValue(new Error('Settings DB unavailable')),
      } as unknown as SettingsService;

      await searchStreamRoutes(
        app,
        createMockIndexerSearchService([{ ...baseResult, title: 'Some Book' }]),
        createMockBlacklistService(),
        throwingSettingsService,
        new SearchSessionManager(),
      );

      appInstance = app;

      const { events } = await fetchSseEvents(app, '/api/search/stream?q=test&apikey=valid-key');
      const data = getSearchComplete(events);

      expect(data.results).toEqual([]);
      expect(data.durationUnknown).toBe(true);
    });
  });
});
