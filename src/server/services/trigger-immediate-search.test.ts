import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('./search-pipeline.js', () => ({
  searchAndGrabForBook: vi.fn().mockResolvedValue(undefined),
  buildNarratorPriority: vi.fn().mockReturnValue([]),
  buildSearchFilterOptions: vi.fn().mockReturnValue({}),
}));

import { triggerImmediateSearch, runImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import { searchAndGrabForBook, buildNarratorPriority } from './search-pipeline.js';

function createMockDeps(): ImmediateSearchDeps {
  return {
    indexerSearchService: {} as never,
    indexerService: {
      getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }),
    } as never,
    downloadOrchestrator: {} as never,
    settingsService: {
      get: vi.fn()
        .mockResolvedValueOnce({ grabFloor: 0 }) // quality
        .mockResolvedValueOnce({ languages: ['english'] }) // metadata
        .mockResolvedValueOnce({ searchPriority: 'accuracy' }), // search
    } as never,
    blacklistService: {} as never,
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) } as never,
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

    await vi.waitFor(() => {
      expect(searchAndGrabForBook).toHaveBeenCalledTimes(1);
    });

    expect(deps.settingsService.get).toHaveBeenCalledWith('quality');
    expect(deps.settingsService.get).toHaveBeenCalledWith('metadata');
    expect(deps.settingsService.get).toHaveBeenCalledWith('search');
    expect(buildNarratorPriority).toHaveBeenCalledWith('accuracy', [{ name: 'Narrator' }]);
    expect(searchAndGrabForBook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        broadcaster: deps.eventBroadcaster,
        eventHistory: deps.eventHistory,
      }),
    );
  });

  it('logs warning and does not throw when settings fetch fails', async () => {
    const settingsGet = vi.fn().mockRejectedValue(new Error('db down'));
    const deps: ImmediateSearchDeps = {
      ...createMockDeps(),
      settingsService: { get: settingsGet } as never,
    };
    const book = { id: 99, title: 'Failing Book' };
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;

    triggerImmediateSearch(book, deps, log);

    await vi.waitFor(() => {
      expect((log as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 99 }),
        'Search-immediately trigger failed',
      );
    }, { timeout: 2000 });

    expect(searchAndGrabForBook).not.toHaveBeenCalled();
  });

  it('returns before the search settles so the caller is never blocked on indexer work', async () => {
    const deps = createMockDeps();
    let releaseSearch!: () => void;
    vi.mocked(searchAndGrabForBook).mockImplementationOnce(
      () => new Promise<never>((resolve) => { releaseSearch = resolve as () => void; }) as never,
    );

    const returned = triggerImmediateSearch({ id: 5, title: 'Detached' }, deps, mockLog);

    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
    releaseSearch();
  });
});

describe('runImmediateSearch (awaitable)', () => {
  it('resolves only after searchAndGrabForBook settles, so a caller can serialize a chain', async () => {
    const deps = createMockDeps();
    let releaseSearch!: () => void;
    vi.mocked(searchAndGrabForBook).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSearch = resolve; }) as never,
    );

    let settled = false;
    const pending = runImmediateSearch({ id: 7, title: 'Serialized' }, deps, mockLog).then(() => { settled = true; });

    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
    // The search is still in flight; an implementation that only issued it would already be settled.
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSearch();
    await pending;
    expect(settled).toBe(true);
  });

  it('contains a search rejection so the next link in a chain still runs', async () => {
    const deps = createMockDeps();
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
    vi.mocked(searchAndGrabForBook).mockRejectedValueOnce(new Error('indexer exploded'));

    await expect(runImmediateSearch({ id: 11, title: 'Boom' }, deps, log)).resolves.toBeUndefined();

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 11 }),
      'Search-immediately trigger failed',
    );
  });

  it('contains a settings-read rejection the same way', async () => {
    const deps: ImmediateSearchDeps = {
      ...createMockDeps(),
      settingsService: { get: vi.fn().mockRejectedValue(new Error('db down')) } as never,
    };
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;

    await expect(runImmediateSearch({ id: 12, title: 'No settings' }, deps, log)).resolves.toBeUndefined();

    expect(searchAndGrabForBook).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 12 }),
      'Search-immediately trigger failed',
    );
  });
});
