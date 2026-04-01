import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { blacklistAndRetrySearch, type BlacklistAndRetryRequest } from './rejection-helpers.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { RetrySearchDeps } from '../services/retry-search.js';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('../services/retry-search.js', () => ({
  retrySearch: vi.fn().mockResolvedValue({ outcome: 'retried' }),
}));

import { retrySearch } from '../services/retry-search.js';

function makeRequest(overrides?: Partial<BlacklistAndRetryRequest>): BlacklistAndRetryRequest {
  return {
    identifiers: { infoHash: 'hash-123', guid: 'guid-abc', title: 'Test Book', bookId: 1 },
    reason: 'wrong_content',
    book: { id: 1 },
    blacklistService: inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) }),
    retrySearchDeps: { log: createMockLogger() } as unknown as RetrySearchDeps,
    settingsService: inject<SettingsService>({ get: vi.fn().mockResolvedValue({ redownloadFailed: true }) }),
    log: inject<FastifyBaseLogger>(createMockLogger()),
    ...overrides,
  };
}

describe('blacklistAndRetrySearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates blacklist entry with provided identifiers and reason', async () => {
    const req = makeRequest();
    await blacklistAndRetrySearch(req);

    expect(req.blacklistService!.create).toHaveBeenCalledWith(expect.objectContaining({
      infoHash: 'hash-123',
      guid: 'guid-abc',
      title: 'Test Book',
      bookId: 1,
      reason: 'wrong_content',
    }));
  });

  it('skips blacklist when both infoHash and guid are missing', async () => {
    const req = makeRequest({
      identifiers: { title: 'Test', bookId: 1 },
    });
    await blacklistAndRetrySearch(req);

    expect(req.blacklistService!.create).not.toHaveBeenCalled();
  });

  it('triggers re-search when redownloadFailed is true', async () => {
    const req = makeRequest();
    await blacklistAndRetrySearch(req);

    await vi.waitFor(() => {
      expect(retrySearch).toHaveBeenCalledWith(1, req.retrySearchDeps);
    });
  });

  it('skips re-search when redownloadFailed is false', async () => {
    const req = makeRequest({
      settingsService: inject<SettingsService>({ get: vi.fn().mockResolvedValue({ redownloadFailed: false }) }),
    });
    await blacklistAndRetrySearch(req);

    await new Promise((r) => setTimeout(r, 0));
    expect(retrySearch).not.toHaveBeenCalled();
  });

  it('skips re-search when book is null', async () => {
    const req = makeRequest({ book: null });
    await blacklistAndRetrySearch(req);

    await new Promise((r) => setTimeout(r, 0));
    expect(retrySearch).not.toHaveBeenCalled();
  });

  it('continues when blacklist creation fails', async () => {
    const req = makeRequest({
      blacklistService: inject<BlacklistService>({ create: vi.fn().mockRejectedValue(new Error('DB error')) }),
    });

    // Should not throw
    await blacklistAndRetrySearch(req);
  });

  it('continues when settings lookup fails', async () => {
    const req = makeRequest({
      settingsService: inject<SettingsService>({ get: vi.fn().mockRejectedValue(new Error('no settings')) }),
    });

    await blacklistAndRetrySearch(req);

    await new Promise((r) => setTimeout(r, 0));
    expect(retrySearch).not.toHaveBeenCalled();
  });
});
