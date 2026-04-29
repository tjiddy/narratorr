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

  it('markDiscoverSuggestionAdded calls POST /discover/suggestions/:id/mark-added', async () => {
    await discoverApi.markDiscoverSuggestionAdded(42);
    expect(mockFetchApi).toHaveBeenCalledWith('/discover/suggestions/42/mark-added', {
      method: 'POST',
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
});
