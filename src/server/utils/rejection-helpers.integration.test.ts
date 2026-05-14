import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { blacklistAndRetrySearch, type BlacklistAndRetryRequest } from './rejection-helpers.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { RetryBudget } from '../services/retry-budget.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BookService } from '../services/book.service.js';
import type { RetrySearchDeps } from '../services/retry-search.js';

// NOTE: This file is intentionally separate from rejection-helpers.test.ts
// because that file vi.mocks retrySearch — which means deleting the real
// imported-book guard inside retrySearch() would not fail those tests.
// This integration test exercises the REAL retrySearch from inside
// blacklistAndRetrySearch so the centralized #1103 guard is covered from
// the rejection-helpers caller surface (B5 in the AC).

function makeImportedBookDeps(retryBudget: RetryBudget) {
  const mockSearchAll = vi.fn().mockResolvedValue([]);
  const mockGrab = vi.fn();
  const deps: RetrySearchDeps = {
    indexerSearchService: inject<IndexerSearchService>({ searchAll: mockSearchAll }),
    downloadOrchestrator: inject<DownloadOrchestrator>({ grab: mockGrab }),
    blacklistService: inject<BlacklistService>({
      getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()),
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    }),
    bookService: inject<BookService>({
      // Imported book — path is non-null, the guard must fire.
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

    // Blacklist write is independent of the retry-search guard and must still fire.
    expect(req.blacklistService!.create).toHaveBeenCalledWith(expect.objectContaining({
      infoHash: 'hash-123',
      reason: 'wrong_content',
    }));

    // Allow the fire-and-forget retrySearch dispatch to settle.
    await new Promise((r) => setTimeout(r, 0));

    // The centralized imported-book guard inside retrySearch() must prevent
    // both indexer search and grab AND must not consume a retry budget attempt.
    expect(mockSearchAll).not.toHaveBeenCalled();
    expect(mockGrab).not.toHaveBeenCalled();
    expect(retryBudget.hasRemaining(1)).toBe(budgetBefore);
  });
});
