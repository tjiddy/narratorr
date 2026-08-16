import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject, createMockSettingsService, mockSearchAllWithStatus } from '../__tests__/helpers.js';
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
