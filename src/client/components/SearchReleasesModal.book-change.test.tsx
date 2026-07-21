import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
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

// Ordering instrumentation for the F4 layout-seam proof. The replace-grab generation
// advance is `useReplaceGrab.reset()`, invoked by the modal's teardown cleanup. Wrap it
// (behaviour-preserving — still calls through) to record WHEN it fires, so a test can
// assert it runs strictly before book B's body is interactive. The grab lifecycle-local
// suppression is async (react-query awaits the mutationFn), so it always runs post-passive
// and can't distinguish the seam by itself; this synchronous ordering marker can.
const { orderMarks } = vi.hoisted(() => ({ orderMarks: [] as string[] }));

vi.mock('@/hooks/useReplaceGrab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useReplaceGrab')>();
  const React = await import('react');
  return {
    ...actual,
    useReplaceGrab: (onSuccess: () => void, title: string) => {
      const real = actual.useReplaceGrab(onSuccess, title);
      // Keep identity stable (real.reset is a stable useCallback) so the modal's
      // teardown layout-effect does not re-run on every render.
      const reset = React.useMemo(
        () => () => { orderMarks.push('A-teardown'); real.reset(); },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the stable reset only
        [real.reset],
      );
      return { ...real, reset };
    },
  };
});

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

// A SYNCHRONOUS promise-like: `.resolve()` runs registered `.then`/`.catch` callbacks
// synchronously (no microtask deferral). Used to hold `api.mintStreamToken` for the F1
// recovery so its continuation fires exactly at the moment we resolve it — i.e. inside
// book B's layout-effect setup, BEFORE passive effects flush. A real Promise would defer
// the continuation to a microtask that (under RTL's rerender auto-act) only runs after
// passive effects have already advanced the session generation, hiding the seam. With the
// continuation running in the pre-passive window, a passive unmount cleanup would still
// see `scheduledGen === sessionGenRef.current` and reopen an orphan stream — the exact bug.
function makeSyncThenable<T>() {
  const queued: Array<() => void> = [];
  let settled: { ok: boolean; value: unknown } | null = null;
  const run = (t: { ok: boolean; value: unknown }, onF?: (v: T) => unknown, onR?: (e: unknown) => unknown, next?: ReturnType<typeof makeSyncThenable>) => {
    try {
      if (t.ok) next?.resolve(onF ? onF(t.value as T) : t.value);
      else if (onR) next?.resolve(onR(t.value));
      else next?.reject(t.value);
    } catch (e) { next?.reject(e); }
  };
  const thenable = {
    then(onF?: (v: T) => unknown, onR?: (e: unknown) => unknown) {
      const next = makeSyncThenable();
      const fire = () => run(settled!, onF, onR, next);
      if (settled) fire(); else queued.push(fire);
      return next;
    },
    catch(onR: (e: unknown) => unknown) { return thenable.then(undefined, onR); },
    resolve(value: T) { if (!settled) { settled = { ok: true, value }; queued.splice(0).forEach(f => f()); } },
    reject(error: unknown) { if (!settled) { settled = { ok: false, value: error }; queued.splice(0).forEach(f => f()); } },
  };
  return thenable;
}

// A sibling probe that fires `onLayout` during its own layout-effect SETUP. Keyed by
// book.id alongside the modal, so on an A→B switch React runs it in the layout phase of
// the SAME commit — strictly after the unmounting A body's layout-effect CLEANUPS (React
// runs all destroys in the mutation phase before all setups in the layout phase) and
// strictly before passive effects flush. Settling a held promise from here is what lets
// the ordering tests observe the A→B transition "before passive effects flush": if a
// teardown seam (session-gen advance / replace-grab reset) were a passive `useEffect`
// cleanup instead of layout, A's generation would NOT yet be advanced at this point and
// the stale settlement would leak a toast/close/orphan-stream — turning these tests red.
function LayoutSettler({ onLayout }: { onLayout: () => void }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once at mount (layout phase)
  useLayoutEffect(() => { onLayout(); }, []);
  return null;
}

function renderModalWithSettler(
  book: ReturnType<typeof createMockBook>,
  onClose: () => void,
  onBLayout: () => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const armed = { current: false };
  const tree = (b: ReturnType<typeof createMockBook>) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SearchReleasesModal isOpen={true} book={b} onClose={onClose} />
        <LayoutSettler key={b.id} onLayout={() => { if (armed.current) onBLayout(); }} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(book));
  return {
    ...view,
    invalidateSpy,
    armForNext: () => { armed.current = true; },
    rerenderBook: (b: ReturnType<typeof createMockBook>) => view.rerender(tree(b)),
  };
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

      // No lifecycle-local effects against B — neither a success toast nor an error
      // toast (F5: a broken stale onError guard for PIPELINE_ACTIVE / the generic
      // branch would fire toast.error while the no-confirm/no-close assertions still
      // pass), no confirm dialog, and B's modal is not closed.
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText('Replace active download?')).not.toBeInTheDocument();

      // On the success path the caches are still reconciled unconditionally.
      if (name === 'success') {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      }
    });
  }

  // F2 — trace the EDITED UI value through the real hook into the actual stream
  // request. The file-wide mock in SearchReleasesModal.test.tsx can only assert a
  // zero-argument start(); here the real useSearchStream builds the URL, so an
  // implementation that forwarded the derived prefill instead of local query state
  // would fail this. Book-derived ranking context must survive the edit.
  it('an edited query reaches the real stream request as q, book context preserved (F2)', async () => {
    const book = createMockBook({
      id: 303,
      title: 'The Shining',
      authors: [{ id: 9, name: 'Stephen King', slug: 'stephen-king' }],
    });
    renderModal(book, vi.fn());

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    // Drive the auto-started search to results so the phase leaves 'searching' and the
    // Search control becomes eligible again.
    driveToResults(openInstances()[0]!, []);

    const input = await screen.findByLabelText('Search query');
    await userEvent.clear(input);
    await userEvent.type(input, 'Doctor Sleep');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));

    await waitFor(() => {
      const params = new URLSearchParams(openInstances().at(-1)!.url.split('?')[1]);
      expect(params.get('q')).toBe('Doctor Sleep');
      expect(params.get('title')).toBe('The Shining');
      expect(params.get('author')).toBe('Stephen King');
    });
  });

  // F4 — prove the replace-grab generation is advanced on the SYNCHRONOUS layout seam.
  // The grab suppression itself is async (react-query awaits the mutationFn), so it can't
  // distinguish layout from passive on its own. Instead assert the ORDER of two markers in
  // the A→B commit: A's replace-grab teardown (`reset()`) fires strictly BEFORE book B's
  // body is interactive (B's layout-effect setup). React runs all layout-effect CLEANUPS
  // (mutation phase) before all layout-effect SETUPS — so a layout-cleanup seam yields
  // [A-teardown, B-interactive]; a passive `useEffect` cleanup would run A-teardown in the
  // passive phase (after B setup), reversing the order and failing this test.
  it('advances the replace-grab generation before book B is interactive — layout-seam ordering (F4)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook, armForNext } = renderModalWithSettler(bookA, vi.fn(), () => {
      orderMarks.push('B-interactive');
    });

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    orderMarks.length = 0; // clear mount-time noise; capture only the transition commit

    armForNext();
    rerenderBook(bookB); // synchronous A→B commit

    expect(orderMarks).toEqual(['A-teardown', 'B-interactive']);
  });

  // F1 — prove the search-session generation is advanced on the SYNCHRONOUS (layout)
  // unmount seam. Hold `api.mintStreamToken` with a SYNCHRONOUS thenable so the recovery
  // continuation fires exactly when book B's layout setup resolves it — in the pre-passive
  // window. A layout unmount cleanup has already advanced A's generation by then, so the
  // continuation opens NO orphan A stream. (A passive cleanup would leave A's session live
  // in this window and the continuation would synchronously reopen a Book A stream.)
  it('advances the session generation on the layout unmount seam — a remint fulfilling at B layout opens no orphan A stream (F1)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const mintThenable = makeSyncThenable<{ token: string; expiresInMs: number }>();
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockReset();
    (api.mintStreamToken as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ token: 'stream-token', expiresInMs: 300_000 }) // A useQuery mount
      .mockReturnValueOnce(mintThenable) // A remint (held, synchronous)
      .mockResolvedValue({ token: 'stream-token', expiresInMs: 300_000 }); // any later mint

    const { rerenderBook, armForNext } = renderModalWithSettler(bookA, vi.fn(), () => {
      mintThenable.resolve({ token: 'token-remint', expiresInMs: 300_000 });
    });

    await waitFor(() => expect(openInstances('Book+A').length).toBeGreaterThan(0));
    // Stream error on A schedules the (held) remint continuation.
    await act(async () => { openInstances('Book+A')[0]!.onerror?.(new Event('error')); });

    // Count EVERY Book A EventSource ever constructed — not just open ones. A passive
    // unmount cleanup would let the continuation CONSTRUCT an orphan A stream (then close
    // it in the same commit's passive phase), so an "open" count would miss the transient
    // construction; a construction count catches it.
    const bookAConstructedBefore = MockEventSource.instances.filter(i => i.url.includes('q=Book+A')).length;

    armForNext();
    // Synchronous A→B commit: B's layout setup resolves the mint, firing the recovery
    // continuation synchronously in the pre-passive window.
    await act(async () => { rerenderBook(bookB); });

    // No orphan A stream was ever constructed — A's session generation was already
    // advanced at the layout unmount seam. Only B's stream is live.
    await waitFor(() => expect(openInstances('Book+B').length).toBe(1));
    expect(MockEventSource.instances.filter(i => i.url.includes('q=Book+A')).length).toBe(bookAConstructedBefore);
    expect(openInstances().length).toBe(1);
  });
});
