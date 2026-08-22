import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FixSeriesModal } from './FixSeriesModal';
import { useEventSource } from '@/hooks/useEventSource';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      searchBookSeries: vi.fn(),
      bindBookSeries: vi.fn(),
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

// The global stub from __tests__/setup.ts is inert — its addEventListener is a no-op, so a harness
// that leaves it installed registers listeners that never fire and every assertion here passes
// vacuously. Swap it per test and restore afterwards.
const ORIGINAL_EVENT_SOURCE = globalThis.EventSource;

const BOOK_ID = 42;
const quartet = { id: 4242, name: 'The Earthsea Quartet', slug: 'q', authorName: 'Ursula K. Le Guin', booksCount: 4, imageUrl: null };

/** Mounts the stream beside the modal so both share one QueryClient, as the real book page does. */
function Harness() {
  useEventSource('stream-token');
  return <FixSeriesModal bookId={BOOK_ID} currentSeriesName="The Earthsea Cycle" onClose={vi.fn()} />;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Stands in for the SeriesCard the real book page renders beside the modal: it is the key whose
  // invalidation proves the event actually reached the handler.
  queryClient.setQueryData(queryKeys.bookSeries(BOOK_ID), { series: null });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return { queryClient };
}

async function dispatchStatusChange() {
  const es = MockEventSource.instances[0]!;
  await act(async () => {
    es.simulateEvent('book_status_change', { book_id: BOOK_ID, old_status: 'wanted', new_status: 'downloading' });
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('FixSeriesModal × useEventSource — a downloading book no longer thrashes the search (#2592)', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
    vi.resetAllMocks();
  });

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).EventSource = ORIGINAL_EVENT_SOURCE;
  });

  it('leaves the results and the provider alone when a status event lands', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [quartet] });
    const { queryClient } = renderPage();
    expect(await screen.findByText('The Earthsea Quartet')).toBeInTheDocument();
    await act(async () => { MockEventSource.instances[0]!.simulateOpen(); });

    await dispatchStatusChange();

    // Positive pin FIRST: without it, "no second provider call" is satisfied by an event that never
    // reached the handler at all.
    expect(queryClient.getQueryState(queryKeys.bookSeries(BOOK_ID))?.isInvalidated).toBe(true);
    expect(api.searchBookSeries).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(queryKeys.bookSeriesSearch(BOOK_ID, 'The Earthsea Cycle'))?.isInvalidated).toBe(false);
    expect(screen.getByText('The Earthsea Quartet')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).toBeNull();
  });

  it('holds through the repeated ticks a running download emits', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [quartet] });
    const { queryClient } = renderPage();
    expect(await screen.findByText('The Earthsea Quartet')).toBeInTheDocument();
    await act(async () => { MockEventSource.instances[0]!.simulateOpen(); });

    for (let tick = 0; tick < 3; tick += 1) {
      await dispatchStatusChange();
      expect(screen.getByText('The Earthsea Quartet')).toBeInTheDocument();
      expect(screen.queryByTestId('loading-spinner')).toBeNull();
    }

    expect(api.searchBookSeries).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(queryKeys.bookSeries(BOOK_ID))?.isInvalidated).toBe(true);
  });

  it('still marks the series card itself invalidated, so #2541 keeps its live buckets', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [quartet] });
    const { queryClient } = renderPage();
    const seriesKey = queryKeys.bookSeries(BOOK_ID);
    await screen.findByText('The Earthsea Quartet');
    await act(async () => { MockEventSource.instances[0]!.simulateOpen(); });

    await waitFor(() => expect(queryClient.getQueryState(seriesKey)?.isInvalidated).toBe(false));
    await dispatchStatusChange();

    expect(queryClient.getQueryState(seriesKey)?.isInvalidated).toBe(true);
  });
});
