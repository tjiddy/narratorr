import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SeriesCard } from './SeriesCard';
import { useEventSource } from '@/hooks/useEventSource';
import type { BookSeriesCardData, BookSeriesMemberCard } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getBookSeries: vi.fn(),
      refreshBookSeries: vi.fn(),
      searchBookSeries: vi.fn(),
      bindBookSeries: vi.fn(),
      addAllInSeries: vi.fn(),
      getSettings: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readyState = 0;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  removeEventListener() { /* noop */ }
  close() { this.readyState = 2; }
  simulateOpen() { this.readyState = 1; this.onopen?.(new Event('open')); }

  simulateEvent(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const ORIGINAL_EVENT_SOURCE = globalThis.EventSource;

const PAGE_BOOK_ID = 42;
const SIBLING_BOOK_ID = 43;

function member(overrides: Partial<BookSeriesMemberCard> & { title: string }): BookSeriesMemberCard {
  return {
    hardcoverBookId: null,
    slug: null,
    position: null,
    imageUrl: null,
    inLibrary: false,
    libraryBookId: null,
    libraryBucket: null,
    ...overrides,
  };
}

function cardWith(members: BookSeriesMemberCard[]): BookSeriesCardData {
  return {
    id: 7,
    name: 'The Band',
    hardcoverSeriesId: 5523,
    seriesAuthor: 'Nicholas Eames',
    lastFetchedAt: null,
    members,
  };
}

function siblingCard(bucket: BookSeriesMemberCard['libraryBucket']): BookSeriesCardData {
  return cardWith([
    member({ hardcoverBookId: 1001, title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: PAGE_BOOK_ID, libraryBucket: 'imported' }),
    member({ hardcoverBookId: 1002, title: 'Bloody Rose', position: 2, inLibrary: true, libraryBookId: SIBLING_BOOK_ID, libraryBucket: bucket }),
  ]);
}

/** Mounts the stream beside the card so both share one QueryClient, as the real book page does. */
function Harness() {
  useEventSource('stream-token');
  return <SeriesCard bookId={PAGE_BOOK_ID} />;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/books/${PAGE_BOOK_ID}`]}>
        <Routes>
          <Route path="/books/:id" element={<Harness />} />
          <Route path="/search" element={<div data-testid="search-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

/** setQueryData notifies observers on a macrotask, so the DOM lags a bare await. */
async function settleNotify() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function dispatchStatusChange(bookId: number) {
  const es = MockEventSource.instances[0]!;
  await act(async () => {
    es.simulateEvent('book_status_change', { book_id: bookId, old_status: 'wanted', new_status: 'downloading' });
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('SeriesCard × useEventSource — live bucket updates (#2541)', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
    vi.resetAllMocks();
  });

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).EventSource = ORIGINAL_EVENT_SOURCE;
  });

  it("repaints a sibling's badge from a status event for that sibling, without navigating", async () => {
    vi.mocked(api.getBookSeries)
      .mockResolvedValueOnce({ series: siblingCard('wanted') })
      .mockResolvedValueOnce({ series: siblingCard('downloading') });

    renderPage();
    expect(await screen.findByText('Wanted')).toBeInTheDocument();

    await dispatchStatusChange(SIBLING_BOOK_ID);

    await waitFor(() => expect(screen.getByText('Downloading')).toBeInTheDocument());
    expect(api.getBookSeries).toHaveBeenCalledTimes(2);
    expect(api.getBookSeries).toHaveBeenLastCalledWith(PAGE_BOOK_ID);
    expect(screen.queryByTestId('search-page')).toBeNull();
  });

  it('a refresh in flight when a status event lands still settles on the refresh response', async () => {
    // The refetch the SSE event provokes is held open past the mutation's write, so a stale body
    // genuinely competes with the refresh response instead of settling first.
    let releaseStaleGet!: (value: { series: BookSeriesCardData }) => void;
    vi.mocked(api.getBookSeries)
      .mockResolvedValueOnce({ series: siblingCard('wanted') })
      .mockReturnValue(new Promise((res) => { releaseStaleGet = res; }));

    let releaseRefresh!: (value: { series: BookSeriesCardData }) => void;
    vi.mocked(api.refreshBookSeries).mockReturnValue(new Promise((res) => { releaseRefresh = res; }));

    const { queryClient } = renderPage();
    await screen.findByText('Wanted');
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
    const setDataSpy = vi.spyOn(queryClient, 'setQueryData');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /refresh series/i }));
    await waitFor(() => expect(api.refreshBookSeries).toHaveBeenCalled());

    await dispatchStatusChange(SIBLING_BOOK_ID);
    expect(api.getBookSeries).toHaveBeenCalledTimes(2);

    await act(async () => { releaseRefresh({ series: siblingCard('failed') }); });
    await settleNotify();
    await act(async () => { releaseStaleGet({ series: siblingCard('wanted') }); });
    await settleNotify();

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('Wanted')).toBeNull();
    expect(queryClient.getQueryData(queryKeys.bookSeries(PAGE_BOOK_ID))).toEqual({ series: siblingCard('failed') });
    // End state alone is not proof: pin that the cancel precedes the write it protects.
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.bookSeries(PAGE_BOOK_ID) });
    expect(Math.min(...cancelSpy.mock.invocationCallOrder))
      .toBeLessThan(Math.max(...setDataSpy.mock.invocationCallOrder));
  });
});
