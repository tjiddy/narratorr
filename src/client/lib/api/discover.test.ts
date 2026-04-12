import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchApi = vi.fn().mockResolvedValue({});

vi.mock('./client.js', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

import { discoverApi } from './discover.js';

beforeEach(() => {
  mockFetchApi.mockClear();
  mockFetchApi.mockResolvedValue({});
});

describe('discoverApi', () => {
  it('getDiscoverSuggestions calls GET /discover/suggestions with no query params', async () => {
    await discoverApi.getDiscoverSuggestions();
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions');
  });

  it('addDiscoverSuggestion calls POST /discover/suggestions/:id/add with no body when no overrides', async () => {
    await discoverApi.addDiscoverSuggestion(42);
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions/42/add', {
      method: 'POST',
    });
  });

  it('addDiscoverSuggestion sends overrides as JSON body when provided', async () => {
    await discoverApi.addDiscoverSuggestion(42, { searchImmediately: true, monitorForUpgrades: false });
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions/42/add', {
      method: 'POST',
      body: JSON.stringify({ searchImmediately: true, monitorForUpgrades: false }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('dismissDiscoverSuggestion calls POST /discover/suggestions/:id/dismiss with correct ID', async () => {
    await discoverApi.dismissDiscoverSuggestion(7);
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions/7/dismiss', {
      method: 'POST',
    });
  });

  it('refreshDiscover calls POST /discover/refresh', async () => {
    await discoverApi.refreshDiscover();
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/refresh', {
      method: 'POST',
    });
  });

  // --- #408: Snooze API method ---

  it('snoozeDiscoverSuggestion calls POST /discover/suggestions/:id/snooze with durationDays', async () => {
    await discoverApi.snoozeDiscoverSuggestion(5, 14);
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions/5/snooze', {
      method: 'POST',
      body: JSON.stringify({ durationDays: 14 }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('getDiscoverStats calls GET /discover/stats', async () => {
    await discoverApi.getDiscoverStats();
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/stats');
  });
});
