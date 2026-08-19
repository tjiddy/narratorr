import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ImmediateSearchBook, ImmediateSearchDeps } from './trigger-immediate-search.js';

vi.mock('./trigger-immediate-search.js', () => ({
  runImmediateSearch: vi.fn(),
  triggerImmediateSearch: vi.fn(),
}));

import { runImmediateSearchChain } from './immediate-search-chain.js';
import { runImmediateSearch } from './trigger-immediate-search.js';

const mockRunImmediateSearch = runImmediateSearch as unknown as ReturnType<typeof vi.fn>;

const mockLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
const deps = {} as ImmediateSearchDeps;

const book = (id: number, title: string): ImmediateSearchBook => ({ id, title });

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res as () => void; reject = rej; });
  return { promise, resolve, reject };
}

/** Drain the microtask queue so a chain in flight settles onto its next gate. */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('runImmediateSearchChain', () => {
  beforeEach(() => {
    // `clearAllMocks` keeps implementations, and these tests install gating ones.
    mockRunImmediateSearch.mockReset();
  });

  // #2304: the regression this exists for. A call-count assertion cannot tell a serial chain from
  // a parallel one, so each book's search is gated and the interleave is the observable.
  it('starts a book only after the previous book has settled, in input order', async () => {
    const gates = new Map([1, 2, 3].map((id) => [id, deferred()]));
    const trace: string[] = [];
    mockRunImmediateSearch.mockImplementation(async (b: ImmediateSearchBook) => {
      trace.push(`start:${b.title}`);
      await gates.get(b.id)!.promise;
      trace.push(`end:${b.title}`);
    });

    const chain = runImmediateSearchChain([book(1, 'A'), book(2, 'B'), book(3, 'C')], deps, mockLog);
    await flush();
    expect(trace).toEqual(['start:A']);

    gates.get(1)!.resolve();
    await flush();
    expect(trace).toEqual(['start:A', 'end:A', 'start:B']);

    gates.get(2)!.resolve();
    await flush();
    expect(trace).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C']);

    gates.get(3)!.resolve();
    await chain;
    expect(trace).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  });

  it('passes each book with the caller-supplied deps and logger', async () => {
    const callerDeps = { settingsService: {} } as ImmediateSearchDeps;
    const books = [book(7, 'First'), book(8, 'Second')];

    await runImmediateSearchChain(books, callerDeps, mockLog);

    expect(mockRunImmediateSearch.mock.calls).toEqual([
      [books[0], callerDeps, mockLog],
      [books[1], callerDeps, mockLog],
    ]);
  });

  it('searches nothing and resolves when there are no books', async () => {
    await expect(runImmediateSearchChain([], deps, mockLog)).resolves.toBeUndefined();

    expect(mockRunImmediateSearch).not.toHaveBeenCalled();
  });

  it('searches the single book and resolves', async () => {
    const only = book(4, 'Only');

    await runImmediateSearchChain([only], deps, mockLog);

    expect(mockRunImmediateSearch).toHaveBeenCalledExactlyOnceWith(only, deps, mockLog);
  });

  // AC5 (#2304): containment belongs to `runImmediateSearch`, which catches and logs. The chain
  // must not add a second, differently-swallowing catch — so a rejection here surfaces rather than
  // being absorbed, which is what proves the chain holds no policy of its own.
  it('does not contain rejections itself — it delegates containment to runImmediateSearch', async () => {
    mockRunImmediateSearch.mockRejectedValueOnce(new Error('containment removed'));

    await expect(runImmediateSearchChain([book(5, 'Boom'), book(6, 'Never')], deps, mockLog))
      .rejects.toThrow('containment removed');

    expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  // AC4 (#2304): pins the absence of the pacing/deadline machinery earlier revisions proposed, so
  // adding one later is a visible contract change rather than a silent one.
  it('adds no wait of its own — it completes with fake timers never advanced', async () => {
    vi.useFakeTimers();
    try {
      mockRunImmediateSearch.mockResolvedValue(undefined);

      await runImmediateSearchChain([book(1, 'A'), book(2, 'B'), book(3, 'C')], deps, mockLog);

      expect(mockRunImmediateSearch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
