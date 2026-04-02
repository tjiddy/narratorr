import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSearchStream } from './useSearchStream';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getAuthConfig: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
    cancelSearchIndexer: vi.fn().mockResolvedValue({ cancelled: true }),
  },
}));

import { api } from '@/lib/api';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
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

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSearchStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    // Reset mock to default resolved value
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Wait for auth config query to resolve before calling start */
  async function waitForAuth(result: { current: ReturnType<typeof useSearchStream> }) {
    await waitFor(() => {
      expect(result.current.state.authReady).toBe(true);
    });
  }

  it('starts in idle phase', () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.indexers).toEqual([]);
  });

  it('opens EventSource with query params on start', async () => {
    const { result } = renderHook(() => useSearchStream('test query', { title: 'Test', author: 'Author' }), { wrapper: createWrapper() });

    await waitForAuth(result);

    act(() => {
      result.current.actions.start();
    });

    expect(result.current.state.phase).toBe('searching');
    expect(MockEventSource.instances).toHaveLength(1);
    const url = MockEventSource.instances[0].url;
    expect(url).toContain('q=test+query');
    expect(url).toContain('title=Test');
    expect(url).toContain('author=Author');
  });

  it('parses search-start event and returns indexer list with pending status', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    expect(result.current.state.sessionId).toBe('session-123');
    expect(result.current.state.indexers).toHaveLength(2);
    expect(result.current.state.indexers[0]).toEqual({ id: 1, name: 'ABB', status: 'pending' });
    expect(result.current.state.indexers[1]).toEqual({ id: 2, name: 'MAM', status: 'pending' });
  });

  it('updates indexer status to complete on indexer-complete event', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      es.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 5, elapsedMs: 200 });
    });

    expect(result.current.state.indexers[0]).toEqual({
      id: 1, name: 'ABB', status: 'complete', resultCount: 5, elapsedMs: 200,
    });
    expect(result.current.state.indexers[1].status).toBe('pending');
  });

  it('updates indexer status to error on indexer-error event', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }],
      });
      es.emit('indexer-error', { indexerId: 1, name: 'ABB', error: 'Timeout', elapsedMs: 30000 });
    });

    expect(result.current.state.indexers[0].status).toBe('error');
    expect(result.current.state.indexers[0].error).toBe('Timeout');
  });

  it('returns search results on search-complete and sets phase to results', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    const mockResponse = {
      results: [{ title: 'Book', indexer: 'ABB' }],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    };

    act(() => {
      es.emit('search-complete', mockResponse);
    });

    expect(result.current.state.phase).toBe('results');
    expect(result.current.state.results).toEqual(mockResponse);
    expect(es.closed).toBe(true);
  });

  it('sends POST to cancel endpoint with correct sessionId and indexerId', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      result.current.actions.cancelIndexer(1);
    });

    expect(api.cancelSearchIndexer).toHaveBeenCalledWith('session-123', 1);
    expect(result.current.state.indexers[0].status).toBe('cancelled');
  });

  it('optimistically sets cancelled status on cancel', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      result.current.actions.cancelIndexer(1);
    });

    // Optimistically marked as cancelled
    expect(result.current.state.indexers[0].status).toBe('cancelled');
    // Other indexer unchanged
    expect(result.current.state.indexers[1].status).toBe('pending');
  });

  it('hasResults returns true when any indexer has resultCount > 0', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    expect(result.current.state.hasResults).toBe(false);

    act(() => {
      es.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 3, elapsedMs: 100 });
    });

    expect(result.current.state.hasResults).toBe(true);
  });

  it('hasResults returns false when all indexers have resultCount 0', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }],
      });
      es.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 0, elapsedMs: 100 });
    });

    expect(result.current.state.hasResults).toBe(false);
  });

  it('sets error state on EventSource connection failure', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.onerror?.(new Event('error'));
    });

    expect(result.current.state.error).toBe('Search connection failed');
    expect(result.current.state.phase).toBe('idle');
  });

  it('cleans up EventSource on unmount', async () => {
    const { result, unmount } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    unmount();
    expect(es.closed).toBe(true);
  });

  it('showResults() transitions to Phase 2 immediately and cancels pending indexers', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
      es.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 5, elapsedMs: 200 });
    });

    act(() => {
      result.current.actions.showResults();
    });

    // Phase transitions to results IMMEDIATELY — doesn't wait for search-complete
    expect(result.current.state.phase).toBe('results');
    // Pending indexer was cancelled
    expect(result.current.state.indexers[1].status).toBe('cancelled');
    expect(api.cancelSearchIndexer).toHaveBeenCalledWith('session-123', 2);
  });

  it('indexer-cancelled event updates only the matching row', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }, { id: 3, name: 'Newznab' }],
      });
    });

    act(() => {
      es.emit('indexer-cancelled', { indexerId: 2, name: 'MAM' });
    });

    // Only indexer 2 is cancelled
    expect(result.current.state.indexers[0].status).toBe('pending');
    expect(result.current.state.indexers[1].status).toBe('cancelled');
    expect(result.current.state.indexers[2].status).toBe('pending');
  });

  it('does not open EventSource when auth config is not yet loaded', () => {
    // Override mock to return pending promise (never resolves during this test)
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    act(() => {
      result.current.actions.start();
    });

    // Should remain idle — no EventSource opened
    expect(result.current.state.phase).toBe('idle');
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('reset clears all state and closes EventSource', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }],
      });
    });

    act(() => {
      result.current.actions.reset();
    });

    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.sessionId).toBeNull();
    expect(result.current.state.indexers).toEqual([]);
    expect(es.closed).toBe(true);
  });
});
