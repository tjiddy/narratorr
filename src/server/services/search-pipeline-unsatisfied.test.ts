import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

import { searchAndGrabForBook, postProcessSearchResults } from './search-pipeline.js';
import { runImmediateSearchChain } from './immediate-search-chain.js';

const AT_LIMIT = { count: 150, limit: 150 };

const simpleBook = { id: 1, title: 'Book One', duration: 3600, authors: [{ name: 'Author A' }] };
const SIMPLE_RUNG_1 = 'Book One Author A';

// A title with a real segment floor, so the cut-rung inversions are exercised by production policy.
const churnBook = { id: 2, title: 'The Churn: An Expanse Novella', duration: 3600, authors: [{ name: 'James S. A. Corey' }] };
const CHURN_RUNG_1 = 'The Churn An Expanse Novella James S A Corey';
const CHURN_CUT_RUNG = 'the churn James S A Corey';
const FLOOR_PASSING = 'The Churn: An Expanse Novella';
const FLOOR_FAILING = 'The Churn (Unabridged) [M4B]';

type ResultOverrides = { [K in keyof SearchResult]?: SearchResult[K] | undefined };

function makeResult(overrides: ResultOverrides = {}): SearchResult {
  const built: SearchResult = {
    title: 'Test Book',
    protocol: 'torrent',
    indexer: 'MyAnonamouse',
    indexerId: 10,
    seeders: 10,
    size: 500 * 1024 * 1024,
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (built as unknown as Record<string, unknown>)[key];
    else (built as unknown as Record<string, unknown>)[key] = value;
  }
  return built;
}

const mamAtLimit = (overrides: ResultOverrides = {}) => makeResult({ unsatisfied: AT_LIMIT, ...overrides });
const other = (overrides: ResultOverrides = {}) =>
  makeResult({ indexer: 'Prowlarr', indexerId: 3, title: 'Prowlarr Release', ...overrides });

describe('#2322 — auto-grab is blocked at the unsatisfied limit', () => {
  let downloadOrchestrator: DownloadOrchestrator;
  let blacklistService: BlacklistService;
  let eventHistory: EventHistoryService;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    downloadOrchestrator = inject<DownloadOrchestrator>({ grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }) });
    blacklistService = inject<BlacklistService>({
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    });
    eventHistory = inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) });
    log = createMockLogger();
  });

  const indexerService = inject<IndexerService>({
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
  });

  const qualitySettings = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 };

  /** Maps transport queries to results; succeeded=1 makes an unlisted query an answered zero. */
  function serviceAnswering(byQuery: Record<string, SearchResult[]>): IndexerSearchService {
    return inject<IndexerSearchService>({
      searchAllWithStatus: vi.fn().mockImplementation(async (query: string) => ({
        results: byQuery[query] ?? [], succeeded: 1, failed: 0,
      })),
    });
  }

  const deps = (indexerSearchService: IndexerSearchService) => ({
    indexerSearchService, downloadOrchestrator, qualitySettings,
    log: inject<FastifyBaseLogger>(log), blacklistService, indexerService, eventHistory,
  });

  const eventsOfType = (type: string) =>
    vi.mocked(eventHistory.create).mock.calls.filter((c) => (c[0] as { eventType: string }).eventType === type);

  describe('the regression this exists for', () => {
    it('issues zero grabs and records the blocked event when every candidate is at the limit', async () => {
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'MAM Only' })] });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'no_results' });
      expect(downloadOrchestrator.grab).not.toHaveBeenCalled();
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'grab_blocked_unsatisfied',
        bookId: 1,
        source: 'auto',
        reason: { indexer: 'MyAnonamouse', count: 150, limit: 150, release_title: 'MAM Only' },
      }));
    });

    it('records the event once per blocked search, not once per discarded release', async () => {
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'MAM A' }), mamAtLimit({ title: 'MAM B' }), mamAtLimit({ title: 'MAM C' })],
      });

      await searchAndGrabForBook(simpleBook, deps(svc));

      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(1);
    });

    it('blocks an import-list sync’s auto-grab without breaking the chain', async () => {
      const svc = serviceAnswering({
        'Book One Author A': [mamAtLimit({ title: 'MAM One' })],
        'Book Two Author B': [mamAtLimit({ title: 'MAM Two' })],
      });

      await runImmediateSearchChain(
        [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }, { id: 2, title: 'Book Two', authors: [{ name: 'Author B' }] }],
        {
          indexerSearchService: svc, indexerService, downloadOrchestrator,
          settingsService: createMockSettingsService() as SettingsService,
          blacklistService, eventHistory,
        },
        inject<FastifyBaseLogger>(log),
      );

      expect(downloadOrchestrator.grab).not.toHaveBeenCalled();
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(2);
    });

    it('follows each book’s own observation when the reported count crosses the limit mid-cycle', async () => {
      const svc = serviceAnswering({
        'Book One Author A': [makeResult({ title: 'Below Limit', unsatisfied: { count: 149, limit: 150 } })],
        'Book Two Author B': [mamAtLimit({ title: 'At Limit' })],
      });

      await runImmediateSearchChain(
        [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }, { id: 2, title: 'Book Two', authors: [{ name: 'Author B' }] }],
        {
          indexerSearchService: svc, indexerService, downloadOrchestrator,
          settingsService: createMockSettingsService() as SettingsService,
          blacklistService, eventHistory,
        },
        inject<FastifyBaseLogger>(log),
      );

      expect(downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(downloadOrchestrator.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }));
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(1);
    });
  });

  describe('mixed result sets fall through rather than stall', () => {
    it('grabs the best remaining non-MAM release and records no blocked event', async () => {
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'MAM Best', seeders: 100 }), other({ seeders: 50 })],
      });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'grabbed', title: 'Prowlarr Release' });
      expect(downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(0);
    });

    it('leaves a search with no MAM entries at all completely unchanged', async () => {
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [other()] });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'grabbed', title: 'Prowlarr Release' });
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('does not block a non-MAM release that happens to share an indexerId shape', async () => {
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [other({ indexerId: 10 })] });

      expect(await searchAndGrabForBook(simpleBook, deps(svc))).toEqual({ result: 'grabbed', title: 'Prowlarr Release' });
    });
  });

  describe('grabbability gate — the limit only explains a grab that would have happened', () => {
    const unlinkedShapes: Array<{ name: string; downloadUrl: string | undefined }> = [
      { name: 'undefined', downloadUrl: undefined },
      { name: 'the empty string', downloadUrl: '' },
    ];

    for (const { name, downloadUrl } of unlinkedShapes) {
      it(`records no blocked event when the only at-limit release has a downloadUrl of ${name}`, async () => {
        const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'Unlinked', downloadUrl })] });

        const result = await searchAndGrabForBook(simpleBook, deps(svc));

        expect(result).toEqual({ result: 'no_results' });
        expect(downloadOrchestrator.grab).not.toHaveBeenCalled();
        expect(eventHistory.create).not.toHaveBeenCalled();
      });
    }

    it('grabs the lower-ranked non-MAM release when the top at-limit release is unlinked', async () => {
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'Unlinked', downloadUrl: undefined, seeders: 100 }), other({ seeders: 50 })],
      });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'grabbed', title: 'Prowlarr Release' });
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(0);
    });

    it('names the linked at-limit release when a higher-ranked at-limit release is unlinked', async () => {
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [
          mamAtLimit({ title: 'Unlinked', downloadUrl: undefined, seeders: 100 }),
          mamAtLimit({ title: 'Linked', seeders: 50 }),
        ],
      });

      await searchAndGrabForBook(simpleBook, deps(svc));

      const blocked = eventsOfType('grab_blocked_unsatisfied');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.[0]).toEqual(expect.objectContaining({
        reason: expect.objectContaining({ release_title: 'Linked' }),
      }));
    });
  });

  describe('cut-rung causality — the floor and the limit are told apart', () => {
    it('reports the pre-existing hold when the floor would have stopped the grab anyway', async () => {
      const svc = serviceAnswering({ [CHURN_CUT_RUNG]: [mamAtLimit({ title: FLOOR_FAILING })] });

      const result = await searchAndGrabForBook(churnBook, deps(svc));

      expect(result).toEqual({ result: 'no_results' });
      expect(eventsOfType('search_relaxed_held')).toHaveLength(1);
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(0);
    });

    it('records the blocked event when the limit removed the release the floor had admitted', async () => {
      const svc = serviceAnswering({
        [CHURN_CUT_RUNG]: [
          mamAtLimit({ title: FLOOR_PASSING, seeders: 100 }),
          other({ title: FLOOR_FAILING, seeders: 50 }),
        ],
      });

      const result = await searchAndGrabForBook(churnBook, deps(svc));

      expect(result).toEqual({ result: 'no_results' });
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(1);
      expect(eventsOfType('search_relaxed_held')).toHaveLength(0);
    });

    it('is inert on a full rung, where the same fixture simply grabs the remainder', async () => {
      const svc = serviceAnswering({
        [CHURN_RUNG_1]: [
          mamAtLimit({ title: FLOOR_PASSING, seeders: 100 }),
          other({ title: FLOOR_FAILING, seeders: 50 }),
        ],
      });

      const result = await searchAndGrabForBook(churnBook, deps(svc));

      expect(result).toEqual({ result: 'grabbed', title: FLOOR_FAILING });
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('grabs normally on a full rung even when the only release fails the cut floor', async () => {
      const svc = serviceAnswering({ [CHURN_RUNG_1]: [mamAtLimit({ title: FLOOR_FAILING, unsatisfied: undefined })] });

      expect(await searchAndGrabForBook(churnBook, deps(svc))).toEqual({ result: 'grabbed', title: FLOOR_FAILING });
    });

    it('carries the observation onto a later rung’s own results', async () => {
      const svc = serviceAnswering({ [CHURN_CUT_RUNG]: [mamAtLimit({ title: FLOOR_PASSING })] });

      await searchAndGrabForBook(churnBook, deps(svc));

      expect(vi.mocked(svc.searchAllWithStatus).mock.calls.map((c) => c[0])).toEqual([CHURN_RUNG_1, CHURN_CUT_RUNG]);
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(1);
    });
  });

  describe('boundaries', () => {
    const grabbing: Array<{ name: string; unsatisfied: SearchResult['unsatisfied'] }> = [
      { name: '149 of 150', unsatisfied: { count: 149, limit: 150 } },
      { name: '0 of 150 (a fresh account)', unsatisfied: { count: 0, limit: 150 } },
      { name: 'nothing attached', unsatisfied: undefined },
    ];

    for (const { name, unsatisfied } of grabbing) {
      it(`grabs normally at ${name}`, async () => {
        const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [makeResult({ ...(unsatisfied !== undefined && { unsatisfied }) })] });

        expect(await searchAndGrabForBook(simpleBook, deps(svc))).toEqual({ result: 'grabbed', title: 'Test Book' });
        expect(eventHistory.create).not.toHaveBeenCalled();
      });
    }

    it('blocks at 151 of 150', async () => {
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [makeResult({ unsatisfied: { count: 151, limit: 150 } })] });

      expect(await searchAndGrabForBook(simpleBook, deps(svc))).toEqual({ result: 'no_results' });
      expect(eventsOfType('grab_blocked_unsatisfied')).toHaveLength(1);
    });

    it('reads the reported limit rather than a hardcoded 150', async () => {
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [makeResult({ unsatisfied: { count: 40, limit: 40 } })] });

      expect(await searchAndGrabForBook(simpleBook, deps(svc))).toEqual({ result: 'no_results' });
    });
  });

  describe('filter interactions', () => {
    it('does not produce a blocked event for an at-limit release the blacklist already dropped', async () => {
      blacklistService = inject<BlacklistService>({
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set<string>(['blocked-hash']), blacklistedGuids: new Set<string>(),
        }),
      });
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'Blacklisted', infoHash: 'blocked-hash', seeders: 100 }), other({ seeders: 50 })],
      });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'grabbed', title: 'Prowlarr Release' });
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('still blocks when the at-limit release reaches the decision through the whole filter chain', async () => {
      blacklistService = inject<BlacklistService>({
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set<string>(['dropped-hash']), blacklistedGuids: new Set<string>(),
        }),
      });
      const svc = serviceAnswering({
        [SIMPLE_RUNG_1]: [
          other({ title: 'Dropped By Blacklist', infoHash: 'dropped-hash' }),
          other({ title: 'Dune EPUB' }),
          mamAtLimit({ title: 'Survivor', language: 'english' }),
        ],
      });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));

      expect(result).toEqual({ result: 'no_results' });
      expect(eventsOfType('grab_blocked_unsatisfied')[0]?.[0]).toEqual(expect.objectContaining({
        reason: expect.objectContaining({ release_title: 'Survivor' }),
      }));
    });
  });

  describe('error isolation', () => {
    it('warns and keeps going when the blocked event fails to persist', async () => {
      eventHistory = inject<EventHistoryService>({ create: vi.fn().mockRejectedValue(new Error('db down')) });
      const svc = serviceAnswering({ [SIMPLE_RUNG_1]: [mamAtLimit({ title: 'MAM Only' })] });

      const result = await searchAndGrabForBook(simpleBook, deps(svc));
      await Promise.resolve();

      expect(result).toEqual({ result: 'no_results' });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        'Failed to record grab_blocked_unsatisfied event',
      );
    });

    it('searches the next book in a multi-book chain after a failed event write', async () => {
      eventHistory = inject<EventHistoryService>({ create: vi.fn().mockRejectedValue(new Error('db down')) });
      const svc = serviceAnswering({
        'Book One Author A': [mamAtLimit({ title: 'MAM One' })],
        'Book Two Author B': [other({ title: 'Grabbable' })],
      });

      await runImmediateSearchChain(
        [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }, { id: 2, title: 'Book Two', authors: [{ name: 'Author B' }] }],
        {
          indexerSearchService: svc, indexerService, downloadOrchestrator,
          settingsService: createMockSettingsService() as SettingsService,
          blacklistService, eventHistory,
        },
        inject<FastifyBaseLogger>(log),
      );

      expect(downloadOrchestrator.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 2 }));
    });
  });
});

describe('#2322 — the observation survives the interactive filter chain', () => {
  const settingsService = inject<SettingsService>({
    get: vi.fn().mockImplementation((cat: string) => {
      if (cat === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 0, rejectWords: '', requiredWords: '', minDownloadSize: 0 });
      if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
      return Promise.resolve({});
    }),
  });

  // postProcessSearchResults runs blacklist → enrich → multipart → quality → language → sort, and
  // this is the seam every consumer reads the value off, so identity preservation is the contract.
  it('leaves the attachment on the MAM result after the full chain', async () => {
    const blacklistService = inject<BlacklistService>({
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    });
    const indexerService = inject<IndexerService>({
      getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
    });
    const input = [
      makeResult({ title: 'MAM Release', language: 'english', unsatisfied: AT_LIMIT }),
      other({ title: 'Prowlarr Release', language: 'english' }),
    ];

    const { results } = await postProcessSearchResults(
      input, 3600, blacklistService, settingsService, indexerService, inject<FastifyBaseLogger>(createMockLogger()),
    );

    expect(results.find((r) => r.title === 'MAM Release')?.unsatisfied).toEqual(AT_LIMIT);
    expect(results.find((r) => r.title === 'Prowlarr Release')).not.toHaveProperty('unsatisfied');
  });
});
