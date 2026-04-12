import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/search-pipeline.js', () => ({
  searchAndGrabForBook: vi.fn().mockResolvedValue(undefined),
  buildNarratorPriority: vi.fn().mockReturnValue([]),
}));

import { triggerImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import { searchAndGrabForBook, buildNarratorPriority } from '../services/search-pipeline.js';

function createMockDeps(): ImmediateSearchDeps {
  return {
    indexerService: {} as never,
    downloadOrchestrator: {} as never,
    settingsService: {
      get: vi.fn()
        .mockResolvedValueOnce({ grabFloor: 0 }) // quality
        .mockResolvedValueOnce({ languages: ['english'] }) // metadata
        .mockResolvedValueOnce({ searchPriority: 'narrator' }), // search
    } as never,
    blacklistService: {} as never,
    eventBroadcaster: {} as never,
  };
}

const mockLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('triggerImmediateSearch', () => {
  it('fetches settings and calls searchAndGrabForBook with correct args', async () => {
    const deps = createMockDeps();
    const book = { id: 1, title: 'Test Book', narrators: [{ name: 'Narrator' }] };

    triggerImmediateSearch(book, deps, mockLog);

    // Wait for the fire-and-forget promise chain to settle
    await vi.waitFor(() => {
      expect(searchAndGrabForBook).toHaveBeenCalledTimes(1);
    });

    expect(deps.settingsService.get).toHaveBeenCalledWith('quality');
    expect(deps.settingsService.get).toHaveBeenCalledWith('metadata');
    expect(deps.settingsService.get).toHaveBeenCalledWith('search');
    expect(buildNarratorPriority).toHaveBeenCalledWith('narrator', [{ name: 'Narrator' }]);
  });

  it('logs warning and does not throw when settings fetch fails', async () => {
    const settingsGet = vi.fn().mockRejectedValue(new Error('db down'));
    const deps: ImmediateSearchDeps = {
      ...createMockDeps(),
      settingsService: { get: settingsGet } as never,
    };
    const book = { id: 99, title: 'Failing Book' };
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    // Should not throw — fire-and-forget
    triggerImmediateSearch(book, deps, log);

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 99 }),
        'Search-immediately trigger failed',
      );
    }, { timeout: 2000 });

    expect(searchAndGrabForBook).not.toHaveBeenCalled();
  });
});
