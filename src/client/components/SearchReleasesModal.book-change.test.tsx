import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { createMockBook } from '@/__tests__/factories';
import { queryKeys } from '@/lib/queryKeys';
import type { SearchResult } from '@/lib/api';

// Real hooks cover keyed-remount and layout-seam races that the unit-test hook mock cannot model.

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

// Record reset ordering because async mutation suppression cannot distinguish layout from passive cleanup.
const { orderMarks } = vi.hoisted(() => ({ orderMarks: [] as string[] }));

vi.mock('@/hooks/useReplaceGrab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useReplaceGrab')>();
  const React = await import('react');
  return {
    ...actual,
    useReplaceGrab: (onSuccess: () => void, title: string) => {
      const real = actual.useReplaceGrab(onSuccess, title);
      // Preserve real.reset identity so teardown does not rerun on ordinary renders.
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

// Run remint continuations during B's layout setup; real Promises defer past this seam
// under RTL's act(), masking orphan-stream regressions.
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

// B's layout setup runs after A's layout cleanup but before passive cleanup, exposing teardown order.
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

  it('keyed remount clears the previous book results', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn());

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    driveToResults(openInstances()[0]!, [resultA]);
    expect(await screen.findByText('Result-For-Book-A')).toBeInTheDocument();

    rerenderBook(bookB);

    expect(screen.queryByText('Result-For-Book-A')).not.toBeInTheDocument();
    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
  });

  it('fresh-book auto-start yields exactly one open stream for B under StrictMode (from results)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn(), true);

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    driveToResults(openInstances()[0]!, [resultA]);
    await screen.findByText('Result-For-Book-A');

    rerenderBook(bookB);

    await waitFor(() => expect(openInstances('Book').length).toBe(1));
    expect(openInstances().length).toBe(1);
    expect(openInstances()[0]!.url).toContain('Book+B');
  });

  it('fresh-book auto-start yields exactly one open stream for B under StrictMode (from searching)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook } = renderModal(bookA, vi.fn(), true);

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));

    rerenderBook(bookB);

    await waitFor(() => expect(openInstances().length).toBe(1));
    expect(openInstances()[0]!.url).toContain('Book+B');
  });

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

      await userEvent.click(screen.getAllByText('Grab')[0]!);
      expect(api.searchGrab).toHaveBeenCalledTimes(1);

      rerenderBook(bookB);
      invalidateSpy.mockClear();

      await act(async () => {
        settle();
        await grabDeferred.promise.catch(() => {});
        await Promise.resolve();
      });

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText('Replace active download?')).not.toBeInTheDocument();

      if (name === 'success') {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      }
    });
  }

  it('an edited query reaches the real stream request as q, book context preserved (F2)', async () => {
    const book = createMockBook({
      id: 303,
      title: 'The Shining',
      authors: [{ id: 9, name: 'Stephen King', slug: 'stephen-king' }],
    });
    renderModal(book, vi.fn());

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    // Exit 'searching' so the edited Search action becomes eligible.
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

  it('a raw punctuation-only edited query reaches the request unsanitized as q=?? (F6)', async () => {
    const book = createMockBook({
      id: 404,
      title: 'Book Title',
      authors: [{ id: 4, name: 'Some Author', slug: 'some-author' }],
    });
    renderModal(book, vi.fn());

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    driveToResults(openInstances()[0]!, []);

    const input = await screen.findByLabelText('Search query');
    await userEvent.clear(input);
    await userEvent.type(input, '??');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));

    await waitFor(() => {
      const params = new URLSearchParams(openInstances().at(-1)!.url.split('?')[1]);
      expect(params.get('q')).toBe('??');
    });
  });

  it('advances the replace-grab generation before book B is interactive — layout-seam ordering (F4)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const { rerenderBook, armForNext } = renderModalWithSettler(bookA, vi.fn(), () => {
      orderMarks.push('B-interactive');
    });

    await waitFor(() => expect(openInstances().length).toBeGreaterThan(0));
    orderMarks.length = 0; // Ignore mount-time reset calls.

    armForNext();
    rerenderBook(bookB);

    expect(orderMarks).toEqual(['A-teardown', 'B-interactive']);
  });

  it('advances the session generation on the layout unmount seam — a remint fulfilling at B layout opens no orphan A stream (F1)', async () => {
    const bookA = createMockBook({ id: 101, title: 'Book A' });
    const bookB = createMockBook({ id: 202, title: 'Book B' });
    const mintThenable = makeSyncThenable<{ token: string; expiresInMs: number }>();
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockReset();
    (api.mintStreamToken as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ token: 'stream-token', expiresInMs: 300_000 }) // A mount
      .mockReturnValueOnce(mintThenable) // Held A remint
      .mockResolvedValue({ token: 'stream-token', expiresInMs: 300_000 }); // Later mints

    const { rerenderBook, armForNext } = renderModalWithSettler(bookA, vi.fn(), () => {
      mintThenable.resolve({ token: 'token-remint', expiresInMs: 300_000 });
    });

    await waitFor(() => expect(openInstances('Book+A').length).toBeGreaterThan(0));
    // Schedule the held A remint.
    await act(async () => { openInstances('Book+A')[0]!.onerror?.(new Event('error')); });

    // Count constructions: passive cleanup could briefly create then close an orphan.
    const bookAConstructedBefore = MockEventSource.instances.filter(i => i.url.includes('q=Book+A')).length;

    armForNext();
    await act(async () => { rerenderBook(bookB); });

    await waitFor(() => expect(openInstances('Book+B').length).toBe(1));
    expect(MockEventSource.instances.filter(i => i.url.includes('q=Book+A')).length).toBe(bookAConstructedBefore);
    expect(openInstances().length).toBe(1);
  });
});
