import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject, createMockSettingsService, mockSearchAllWithStatus, captureDeadlineTimers } from '../__tests__/helpers.js';
import { blacklistAndRetrySearch, type BlacklistAndRetryRequest } from './rejection-helpers.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import { RetryBudget } from './retry-budget.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BookService } from './book.service.js';
import type { IndexerService } from './indexer.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import type { EventHistoryService } from './event-history.service.js';
import { _resetSearchRegistryForTesting } from './search-deadline.js';

// Keep retrySearch real: the unit suite mocks it and cannot detect deletion of its imported guard.

function makeImportedBookDeps(retryBudget: RetryBudget) {
  const mockSearchAll = mockSearchAllWithStatus([]);
  const mockGrab = vi.fn();
  const deps: RetrySearchDeps = {
    indexerSearchService: inject<IndexerSearchService>({ searchAllWithStatus: mockSearchAll }),
    indexerService: inject<IndexerService>({
      getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }),
    }),
    downloadOrchestrator: inject<DownloadOrchestrator>({ grab: mockGrab }),
    blacklistService: inject<BlacklistService>({
      getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()),
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    }),
    bookService: inject<BookService>({
      // A non-null path triggers the imported-book guard.
      getById: vi.fn().mockResolvedValue({
        id: 1,
        title: 'Imported Book',
        duration: 3600,
        path: '/library/imported-book',
        authors: [{ name: 'Author' }],
        narrators: [],
      }),
    }),
    settingsService: createMockSettingsService(),
    retryBudget,
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(undefined) }),
    log: inject<FastifyBaseLogger>(createMockLogger()),
  };
  return { deps, mockSearchAll, mockGrab };
}

function makeRequest(overrides: Partial<BlacklistAndRetryRequest>): BlacklistAndRetryRequest {
  return {
    identifiers: { infoHash: 'hash-123', guid: 'guid-abc', title: 'Imported Book', bookId: 1 },
    reason: 'wrong_content',
    book: { id: 1 },
    blacklistService: inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) }),
    settingsService: inject<SettingsService>({ get: vi.fn().mockResolvedValue({ redownloadFailed: true }) }),
    log: inject<FastifyBaseLogger>(createMockLogger()),
    ...overrides,
  } as BlacklistAndRetryRequest;
}

describe('blacklistAndRetrySearch — imported-book guard integration (#1103 F3)', () => {
  it('blacklist still fires but retrySearch short-circuits — no grab, budget unchanged', async () => {
    const retryBudget = new RetryBudget();
    const { deps, mockSearchAll, mockGrab } = makeImportedBookDeps(retryBudget);
    const req = makeRequest({ retrySearchDeps: deps });

    const budgetBefore = retryBudget.hasRemaining(1);

    await blacklistAndRetrySearch(req);

    expect(req.blacklistService!.create).toHaveBeenCalledWith(expect.objectContaining({
      infoHash: 'hash-123',
      reason: 'wrong_content',
    }));

    // Flush the fire-and-forget retry dispatch.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSearchAll).not.toHaveBeenCalled();
    expect(mockGrab).not.toHaveBeenCalled();
    expect(retryBudget.hasRemaining(1)).toBe(budgetBefore);
  });
});

/**
 * #2477 error isolation for the other fire-and-forget caller. `blacklistAndRetrySearch` dispatches
 * the retry and only ever sees a rejection, so an expiry that rejected instead of resolving would
 * fire a warn that means "the retry crashed" for what is an ordinary bounded outcome.
 */
describe('blacklistAndRetrySearch — the detached retry is bounded, not rejecting (#2477)', () => {
  let armed: Array<() => void>;

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    armed = captureDeadlineTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  function makeWantedBookDeps(retryBudget: RetryBudget) {
    const mockSearchAll = vi.fn(() => new Promise<never>(() => { /* never settles */ }));
    const mockGrabForRetry = vi.fn();
    const log = createMockLogger();
    const deps: RetrySearchDeps = {
      indexerSearchService: inject<IndexerSearchService>({ searchAllWithStatus: mockSearchAll }),
      indexerService: inject<IndexerService>({
        getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }),
      }),
      downloadOrchestrator: inject<DownloadOrchestrator>({
        grabForRetry: mockGrabForRetry,
        hasGrabBlocker: vi.fn().mockResolvedValue(false),
      }),
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
      }),
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue({
          id: 1, title: 'Wanted Book', duration: 3600, path: null,
          authors: [{ name: 'Author' }], narrators: [],
        }),
      }),
      settingsService: createMockSettingsService(),
      retryBudget,
      eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(undefined) }),
      log: inject<FastifyBaseLogger>(log),
    };
    return { deps, mockSearchAll, mockGrabForRetry, log };
  }

  it('expires without firing the dispatch catch, and leaves the blacklist write intact', async () => {
    const { deps, mockSearchAll, mockGrabForRetry } = makeWantedBookDeps(new RetryBudget());
    const requestLog = createMockLogger();
    const req = makeRequest({
      retrySearchDeps: deps,
      log: inject<FastifyBaseLogger>(requestLog),
      book: { id: 1 },
    });

    await blacklistAndRetrySearch(req);

    await vi.waitFor(() => expect(mockSearchAll).toHaveBeenCalledTimes(1));
    expect(armed).toHaveLength(1);
    armed[0]!();

    // Nothing to await — the dispatch is detached, so the absence of the warn is the observable.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(requestLog.warn).not.toHaveBeenCalledWith(expect.anything(), 'Re-search after reject failed');
    expect(req.blacklistService!.create).toHaveBeenCalledWith(expect.objectContaining({
      infoHash: 'hash-123', reason: 'wrong_content',
    }));
    expect(mockGrabForRetry).not.toHaveBeenCalled();
  });
});
