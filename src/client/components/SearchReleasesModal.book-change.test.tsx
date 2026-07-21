import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { createMockBook } from '@/__tests__/factories';
import { queryKeys } from '@/lib/queryKeys';
import type { SearchResult } from '@/lib/api';

// ============================================================================
// Lifecycle integration tests (#1905). Unlike SearchReleasesModal.test.tsx, this
// file uses the REAL useSearchStream / useReplaceGrab — the keyed remount, the
// synchronous grab-generation seam, and the token re-mint session contract cannot
// be modelled by the file-wide hook mock. EventSource / api.mintStreamToken /
// api.searchGrab are stubbed instead.
// ============================================================================

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  return { MockApiError };
});

let grabDeferred: { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      mintStreamToken: vi.fn().mockResolvedValue({ token: 'stream-token', expiresInMs: 300_000 }),
      cancelSearchIndexer: vi.fn().mockResolvedValue({ cancelled: true }),
      searchGrab: vi.fn(() => grabDeferred.promise),
      addToBlacklist: vi.fn().mockResolvedValue({}),
    },
    formatBytes: (bytes?: number) => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '0 B'),
    ApiError: MockApiError,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

// ---- MockEventSource --------------------------------------------------------
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

function openInstances(query?: string): MockEventSource[] {
  return MockEventSource.instances.filter(
    es => !es.closed && (query === undefined || es.url.includes(`q=${query}`)),
  );
}

const resultA: SearchResult = {
  title: 'Result-For-Book-A',
  author: 'Author A',
  protocol: 'torrent',
  infoHash: 'hash-a',
  downloadUrl: 'magnet:?xt=urn:btih:hash-a',
  size: 5 * 1024 ** 3,
  seeders: 10,
  indexer: 'ABB',
  indexerId: 1,
};

/** Drive an auto-started stream to the results phase with the given results. */
function driveToResults(es: MockEventSource, results: SearchResult[]) {
  act(() => {
    es.emit('search-start', { sessionId: 's1', indexers: [{ id: 1, name: 'ABB' }] });
    es.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: results.length, elapsedMs: 50 });
    es.emit('search-complete', {
      results,
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    });
  });
}

function makeDeferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderModal(book: ReturnType<typeof createMockBook>, onClose: () => void, strict = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const tree = (ui: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{strict ? <StrictMode>{ui}</StrictMode> : ui}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(<SearchReleasesModal isOpen={true} book={book} onClose={onClose} />));
  return {
    ...view,
    invalidateSpy,
    rerenderBook: (b: ReturnType<typeof createMockBook>) =>
      view.rerender(tree(<SearchReleasesModal isOpen={true} book={b} onClose={onClose} />)),
  };
}

describe('SearchReleasesModal — book-change lifecycle (#1905)', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    grabDeferred = makeDeferred();
    vi.stubGlobal('EventSource', MockEventSource);
    (api.searchGrab as ReturnType<typeof vi.fn>).mockClear();
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'stream-token', expiresInMs: 300_000 });
    (toast.success as ReturnType<typeof vi.fn>).mockClear();
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // F7 — a book.id change remounts the keyed body, discarding the previous book's
  // results synchronously; they are neither rendered nor grab-eligible under B.
  it('keyed remount clears the previous book results', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn());

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    driveToResults(openInstances()[0]!, [resultA]);
    expect(await screen.findByText('Result-For-Book-A')).toBeInTheDocument();

    rerenderBook(bookB);

    // A's row is gone synchronously; B has auto-started a fresh (result-less) search.
    expect(screen.queryByText('Result-For-Book-A')).not.toBeInTheDocument();
    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
  });

  // F8 / F12 — under StrictMode, switching to B from a results phase converges on
  // exactly one live stream for B (each start() closes the prior), no reopen loop.
  it('fresh-book auto-start yields exactly one open stream for B under StrictMode (from results)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn(), true);

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    driveToResults(openInstances()[0]!, [resultA]);
    await screen.findByText('Result-For-Book-A');

    rerenderBook(bookB);

    await waitFor(() => expect(openInstances('Book').length).toBe(1));
    // The single live stream is B's; probe/superseded instances are closed.
    expect(openInstances().length).toBe(1);
    expect(openInstances()[0]!.url).toContain('Book+B');
  });

  it('fresh-book auto-start yields exactly one open stream for B under StrictMode (from searching)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn(), true);

    // Leave A in the searching phase (auto-started, no results emitted).
    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));

    rerenderBook(bookB);

    await waitFor(() => expect(openInstances().length).toBe(1));
    expect(openInstances()[0]!.url).toContain('Book+B');
  });

  // F10 / F16 — an in-flight grab from book A that settles AFTER switching to B must
  // not toast/confirm/close against B; the cache invalidations still run.
  const settlements = [
    { name: 'success', settle: () => grabDeferred.resolve({ id: 1, title: 'x' }) },
    { name: 'ACTIVE_DOWNLOAD_EXISTS 409', settle: () => grabDeferred.reject(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Other' }, count: 1 })) },
    { name: 'PIPELINE_ACTIVE 409', settle: () => grabDeferred.reject(new MockApiError(409, { code: 'PIPELINE_ACTIVE', reason: 'processing' })) },
    { name: 'generic error', settle: () => grabDeferred.reject(new MockApiError(500, { error: 'boom' })) },
  ];

  for (const { name, settle } of settlements) {
    it(`in-flight grab settling as ${name} after switch to B does not affect B, but still invalidates caches`, async () => {
      const onClose = vi.fn();
      const bookA = createMockBook({ id: 101, title: 'Book A' });
      const bookB = createMockBook({ id: 202, title: 'Book B' });
      const { rerenderBook, invalidateSpy } = renderModal(bookA, onClose);

      await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
      driveToResults(openInstances()[0]!, [resultA]);
      await screen.findByText('Result-For-Book-A');

      // Start a grab for book A (searchGrab promise held).
      await userEvent.click(screen.getAllByText('Grab')[0]!);
      expect(api.searchGrab).toHaveBeenCalledTimes(1);

      // Switch to B — remounts, advancing book A's replace generation synchronously.
      rerenderBook(bookB);
      invalidateSpy.mockClear();

      // Settle the stale grab.
      await act(async () => {
        settle();
        await grabDeferred.promise.catch(() => {});
        await Promise.resolve();
      });

      // No lifecycle-local effects against B.
      expect(toast.success).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText('Replace active download?')).not.toBeInTheDocument();

      // On the success path the caches are still reconciled unconditionally.
      if (name === 'success') {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      }
    });
  }
});
