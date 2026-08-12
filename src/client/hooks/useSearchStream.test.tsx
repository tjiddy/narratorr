import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { useSearchStream } from './useSearchStream';
import type { DownloadProtocol } from '@core/indexers/types.js';

// Search streams authenticate with minted tokens, never the API key (#1453).
vi.mock('@/lib/api', () => ({
  api: {
    mintStreamToken: vi.fn().mockResolvedValue({ token: 'test-stream-token', expiresInMs: 300_000 }),
    cancelSearchIndexer: vi.fn().mockResolvedValue({ cancelled: true }),
  },
}));

import { api } from '@/lib/api';

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

  emitRaw(type: string, rawData: string) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler(new MessageEvent(type, { data: rawData }));
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
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'test-stream-token', expiresInMs: 300_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    const url = MockEventSource.instances[0]!.url;
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
      es!.emit('search-start', {
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
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      es!.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 5, elapsedMs: 200 });
    });

    expect(result.current.state.indexers[0]).toEqual({
      id: 1, name: 'ABB', status: 'complete', resultCount: 5, elapsedMs: 200,
    });
    expect(result.current.state.indexers[1]!.status).toBe('pending');
  });

  it('updates indexer status to error on indexer-error event', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }],
      });
      es!.emit('indexer-error', { indexerId: 1, name: 'ABB', error: 'Timeout', elapsedMs: 30000 });
    });

    expect(result.current.state.indexers[0]!.status).toBe('error');
    expect(result.current.state.indexers[0]!.error).toBe('Timeout');
  });

  it('returns search results on search-complete and sets phase to results', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    const mockResponse = {
      results: [{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    };

    act(() => {
      es!.emit('search-complete', mockResponse);
    });

    expect(result.current.state.phase).toBe('results');
    expect(result.current.state.results).toEqual(mockResponse);
    expect(es!.closed).toBe(true);
  });

  // SearchResponse is independent of the schema: this runtime check catches Zod stripping the
  // field, while search-stream.test.ts supplies the compile-time compatibility guard (#2104).
  it('carries relaxedQuery from the search-complete payload into state (AC39)', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    act(() => {
      MockEventSource.instances[0]!.emit('search-complete', {
        results: [{ title: 'Star Wars: Haunted Starlight', indexer: 'ABB', protocol: 'torrent' as const }],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
        relaxedQuery: 'star wars haunted starlight',
      });
    });

    expect(result.current.state.results?.relaxedQuery).toBe('star wars haunted starlight');
  });

  it('leaves relaxedQuery undefined when the payload omits it', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    act(() => {
      MockEventSource.instances[0]!.emit('search-complete', {
        results: [],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      });
    });

    expect(result.current.state.results?.relaxedQuery).toBeUndefined();
  });

  describe('removeResult', () => {
    type Fixture = {
      title: string;
      indexer: string;
      protocol: DownloadProtocol;
      infoHash?: string;
      guid?: string;
    };

    async function startWithResults(results: Fixture[]) {
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      act(() => {
        MockEventSource.instances[0]!.emit('search-complete', {
          results,
          durationUnknown: false,
          unsupportedResults: { count: 0, titles: [] },
        });
      });
      return result;
    }

    // Server parity requires independent OR-matching of infoHash and guid.
    it('removes a dual-identifier row matched by its infoHash alone', async () => {
      const result = await startWithResults([
        { title: 'Dual D', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashD', guid: 'guidD' },
        { title: 'Control', indexer: 'NZB', protocol: 'usenet', guid: 'guidZ' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: 'hashD' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    it('removes a dual-identifier row matched by its guid alone', async () => {
      const result = await startWithResults([
        { title: 'Dual D', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashD', guid: 'guidD' },
        { title: 'Control', indexer: 'NZB', protocol: 'usenet', guid: 'guidZ' },
      ]);

      act(() => { result.current.actions.removeResult({ guid: 'guidD' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    // A guid match also removes siblings that do not share the infoHash.
    it('removes a guid-only sibling sharing the blacklisted row guid', async () => {
      const result = await startWithResults([
        { title: 'Dual A', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashA', guid: 'guidA' },
        { title: 'Guid Sibling', indexer: 'NZB', protocol: 'usenet', guid: 'guidA' },
        { title: 'Control', indexer: 'MAM', protocol: 'torrent', infoHash: 'hashZ' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: 'hashA', guid: 'guidA' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    // Empty identifiers must fail a truthiness guard; `!= null` would match unrelated empty rows.
    it('treats an empty-string identifier as a non-match', async () => {
      const result = await startWithResults([
        { title: 'Empty X', indexer: 'NZB', protocol: 'usenet', infoHash: '', guid: 'guidX' },
        { title: 'Empty Y', indexer: 'NZB', protocol: 'usenet', infoHash: '', guid: 'guidY' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: '', guid: 'guidX' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Empty Y']);
    });

    // Server blacklisting removes every shared identity, not only the first match.
    it('removes every row sharing one infoHash', async () => {
      const result = await startWithResults([
        { title: 'Shared 1', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashS' },
        { title: 'Shared 2', indexer: 'MAM', protocol: 'torrent', infoHash: 'hashS' },
        { title: 'Control', indexer: 'NZB', protocol: 'usenet', guid: 'guidZ' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: 'hashS' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    it('is a no-op for an empty/absent ref, returning the same prev reference', async () => {
      const result = await startWithResults([
        { title: 'Row', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashR' },
      ]);
      const before = result.current.state.results;

      act(() => { result.current.actions.removeResult({}); });
      expect(result.current.state.results).toBe(before);

      act(() => { result.current.actions.removeResult({ infoHash: '', guid: '' }); });
      expect(result.current.state.results).toBe(before);
      expect(result.current.state.results?.results).toHaveLength(1);
    });

    it('is a no-op when the ref matches no held result, returning the same prev reference', async () => {
      const result = await startWithResults([
        { title: 'Row', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashR' },
      ]);
      const before = result.current.state.results;

      act(() => { result.current.actions.removeResult({ infoHash: 'not-present' }); });

      expect(result.current.state.results).toBe(before);
      expect(result.current.state.results?.results).toHaveLength(1);
    });

    it('is a no-op when there are no results yet', () => {
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

      act(() => { result.current.actions.removeResult({ infoHash: 'anything' }); });

      expect(result.current.state.results).toBeNull();
    });
  });

  it('sends POST to cancel endpoint with correct sessionId and indexerId', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      result.current.actions.cancelIndexer(1);
    });

    expect(api.cancelSearchIndexer).toHaveBeenCalledWith('session-123', 1);
    expect(result.current.state.indexers[0]!.status).toBe('cancelled');
  });

  it('optimistically sets cancelled status on cancel', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    act(() => {
      result.current.actions.cancelIndexer(1);
    });

    expect(result.current.state.indexers[0]!.status).toBe('cancelled');
    expect(result.current.state.indexers[1]!.status).toBe('pending');
  });

  it('hasResults returns true when any indexer has resultCount > 0', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
    });

    expect(result.current.state.hasResults).toBe(false);

    act(() => {
      es!.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 3, elapsedMs: 100 });
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
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }],
      });
      es!.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 0, elapsedMs: 100 });
    });

    expect(result.current.state.hasResults).toBe(false);
  });

  it('re-mints and reconnects on a stream error (token expiry) instead of failing permanently', async () => {
    // `mockClear` resets call history without draining the once queue used by this assertion.
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
    (api.mintStreamToken as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
      .mockResolvedValueOnce({ token: 'token-2', expiresInMs: 300_000 });

    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toContain('token=token-1');

    await act(async () => {
      MockEventSource.instances[0]!.onerror?.(new Event('error'));
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    expect(api.mintStreamToken).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances.at(-1)!.url).toContain('token=token-2');
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.phase).toBe('searching');
  });

  it('treats a second stream error after re-mint as a terminal failure (no infinite reconnect)', async () => {
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
    (api.mintStreamToken as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
      .mockResolvedValueOnce({ token: 'token-2', expiresInMs: 300_000 });

    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    await act(async () => {
      MockEventSource.instances[0]!.onerror?.(new Event('error'));
    });
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    await act(async () => {
      MockEventSource.instances.at(-1)!.onerror?.(new Event('error'));
    });

    expect(result.current.state.error).toBe('Search connection failed');
    expect(result.current.state.phase).toBe('idle');
    expect(api.mintStreamToken).toHaveBeenCalledTimes(2);
  });

  it('cleans up EventSource on unmount', async () => {
    const { result, unmount } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    expect(es!.closed).toBe(false);

    unmount();
    expect(es!.closed).toBe(true);
  });

  it('showResults() transitions to Phase 2 immediately and cancels pending indexers', async () => {
    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
      });
      es!.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 5, elapsedMs: 200 });
    });

    act(() => {
      result.current.actions.showResults();
    });

    expect(result.current.state.phase).toBe('results');
    expect(result.current.state.indexers[1]!.status).toBe('cancelled');
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
      es!.emit('search-start', {
        sessionId: 'session-123',
        indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }, { id: 3, name: 'Newznab' }],
      });
    });

    act(() => {
      es!.emit('indexer-cancelled', { indexerId: 2, name: 'MAM' });
    });

    expect(result.current.state.indexers[0]!.status).toBe('pending');
    expect(result.current.state.indexers[1]!.status).toBe('cancelled');
    expect(result.current.state.indexers[2]!.status).toBe('pending');
  });

  it('does not open EventSource when the stream token is not yet minted', () => {
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    act(() => {
      result.current.actions.start();
    });

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
      es!.emit('search-start', {
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
    expect(es!.closed).toBe(true);
  });

  describe('AC2 — finalizing timeout', () => {
    it('shows error state when timeout fires with no search-complete received', async () => {
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 100 }),
        { wrapper: createWrapper() },
      );

      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', {
          sessionId: 'session-123',
          indexers: [{ id: 1, name: 'ABB' }],
        });
      });

      act(() => { result.current.actions.showResults(); });
      expect(result.current.state.phase).toBe('results');
      expect(result.current.state.results).toBeNull();

      await waitFor(() => {
        expect(result.current.state.error).toBe('Search timed out waiting for results');
      });
      expect(result.current.state.phase).toBe('idle');
    });

    it('clears timeout when search-complete arrives before timeout', async () => {
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 200 }),
        { wrapper: createWrapper() },
      );

      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', { sessionId: 'session-123', indexers: [{ id: 1, name: 'ABB' }] });
      });

      act(() => { result.current.actions.showResults(); });

      act(() => {
        es!.emit('search-complete', { results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } });
      });

      expect(result.current.state.results).not.toBeNull();
      expect(result.current.state.phase).toBe('results');
      expect(result.current.state.error).toBeNull();

      await new Promise(r => setTimeout(r, 300));
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.phase).toBe('results');
    });

    it('re-enters searching phase when retry is triggered after timeout', async () => {
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 100 }),
        { wrapper: createWrapper() },
      );

      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', { sessionId: 'session-123', indexers: [{ id: 1, name: 'ABB' }] });
      });

      act(() => { result.current.actions.showResults(); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe('idle');
      });
      expect(result.current.state.error).toBeTruthy();

      act(() => { result.current.actions.reset(); });
      act(() => { result.current.actions.start(); });

      expect(result.current.state.phase).toBe('searching');
      expect(MockEventSource.instances).toHaveLength(2);
    });

    it('falls back to error immediately when onerror fires while in finalizing state', async () => {
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 10000 }),
        { wrapper: createWrapper() },
      );

      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', { sessionId: 'session-123', indexers: [{ id: 1, name: 'ABB' }] });
      });

      act(() => { result.current.actions.showResults(); });
      expect(result.current.state.phase).toBe('results');

      act(() => {
        if (es!.onerror) es!.onerror(new Event('error'));
      });

      expect(result.current.state.error).toBe('Search connection failed');
      expect(result.current.state.phase).toBe('idle');
    });
  });

  describe('SSE payload validation', () => {
    async function startWithSession() {
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => {
        es!.emit('search-start', {
          sessionId: 'session-123',
          indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
        });
      });
      return { result, es };
    }

    it('search-start: malformed JSON leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[0];

      act(() => { es!.emitRaw('search-start', 'not-json'); });

      expect(result.current.state.sessionId).toBeNull();
      expect(result.current.state.indexers).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('search-start');
    });

    it('search-start: missing required field leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[0];

      act(() => { es!.emit('search-start', { sessionId: 'abc' }); });

      expect(result.current.state.sessionId).toBeNull();
      expect(result.current.state.indexers).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('search-start');
    });

    it('search-start: extra unknown fields are tolerated (Zod default permissive)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.emit('search-start', {
          sessionId: 'session-123',
          indexers: [{ id: 1, name: 'ABB' }],
          unknown: 'extra-field',
        });
      });

      expect(result.current.state.sessionId).toBe('session-123');
      expect(result.current.state.indexers).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('indexer-complete: malformed JSON leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => { es!.emitRaw('indexer-complete', '<<not-json>>'); });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-complete');
    });

    it('indexer-complete: wrong-type indexerId leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-complete', { indexerId: 'not-a-number', name: 'x', resultCount: 5, elapsedMs: 100 });
      });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(result.current.state.indexers[1]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-complete');
    });

    it('indexer-complete: well-formed payload updates the matching row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-complete', { indexerId: 1, name: 'ABB', resultCount: 7, elapsedMs: 250 });
      });

      expect(result.current.state.indexers[0]).toEqual({
        id: 1, name: 'ABB', status: 'complete', resultCount: 7, elapsedMs: 250,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('indexer-error: malformed JSON leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => { es!.emitRaw('indexer-error', 'invalid'); });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-error');
    });

    it('indexer-error: missing required field leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-error', { indexerId: 1, name: 'ABB', elapsedMs: 100 });
      });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-error');
    });

    it('indexer-error: well-formed payload updates the matching row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-error', { indexerId: 2, name: 'MAM', error: 'Boom', elapsedMs: 50 });
      });

      expect(result.current.state.indexers[1]!.status).toBe('error');
      expect(result.current.state.indexers[1]!.error).toBe('Boom');
      expect(warn).not.toHaveBeenCalled();
    });

    it('indexer-cancelled: malformed JSON leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => { es!.emitRaw('indexer-cancelled', '###'); });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-cancelled');
    });

    it('indexer-cancelled: schema mismatch leaves state unchanged and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-cancelled', { indexerId: '1', name: 'ABB' });
      });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('indexer-cancelled');
    });

    it('indexer-cancelled: well-formed payload updates the matching row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => { es!.emit('indexer-cancelled', { indexerId: 1, name: 'ABB' }); });

      expect(result.current.state.indexers[0]!.status).toBe('cancelled');
      expect(warn).not.toHaveBeenCalled();
    });

    it('search-complete: well-formed payload sets results and closes stream', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      const payload = {
        results: [{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      act(() => { es!.emit('search-complete', payload); });

      expect(result.current.state.phase).toBe('results');
      expect(result.current.state.results).toEqual(payload);
      expect(es!.closed).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('search-complete: malformed JSON closes stream, clears timeout, and surfaces error (AC5)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 200 }),
        { wrapper: createWrapper() },
      );
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', { sessionId: 'session-123', indexers: [{ id: 1, name: 'ABB' }] });
      });
      act(() => { result.current.actions.showResults(); });

      act(() => { es!.emitRaw('search-complete', 'not-json'); });

      expect(es!.closed).toBe(true);
      expect(result.current.state.phase).toBe('idle');
      expect(result.current.state.error).toBeTruthy();
      expect(result.current.state.error).not.toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('search-complete');

      // Verify the finalizing timeout was cleared; otherwise its late callback overwrites this error.
      const errorBefore = result.current.state.error;
      await new Promise(r => setTimeout(r, 300));
      expect(result.current.state.error).toBe(errorBefore);
    });

    it('search-complete: schema mismatch closes stream, clears timeout, and surfaces error (AC5)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(
        () => useSearchStream('test query', undefined, { finalizingTimeoutMs: 200 }),
        { wrapper: createWrapper() },
      );
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const es = MockEventSource.instances[0];
      act(() => {
        es!.emit('search-start', { sessionId: 'session-123', indexers: [{ id: 1, name: 'ABB' }] });
      });
      act(() => { result.current.actions.showResults(); });

      act(() => {
        es!.emit('search-complete', {
          results: [{ title: 'Book', indexer: 'ABB' }],
          durationUnknown: false,
          unsupportedResults: { count: 0, titles: [] },
        });
      });

      expect(es!.closed).toBe(true);
      expect(result.current.state.phase).toBe('idle');
      expect(result.current.state.error).toBeTruthy();
      expect(result.current.state.error).not.toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('search-complete');

      const errorBefore = result.current.state.error;
      await new Promise(r => setTimeout(r, 300));
      expect(result.current.state.error).toBe(errorBefore);
    });

    it('indexer-complete for unknown indexerId is a no-op (referential validation is not the schema\'s job)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, es } = await startWithSession();

      act(() => {
        es!.emit('indexer-complete', { indexerId: 999, name: 'Phantom', resultCount: 5, elapsedMs: 100 });
      });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(result.current.state.indexers[1]!.status).toBe('pending');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('search-session contract & context clamp (#1905)', () => {
    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    function urlParams(url: string): URLSearchParams {
      return new URLSearchParams(url.split('?')[1] ?? '');
    }

    it('clamps context title to 500 and author to 200 chars in the stream URL (F15)', async () => {
      const longTitle = 'T'.repeat(600);
      const longAuthor = 'A'.repeat(250);
      const { result } = renderHook(
        () => useSearchStream('valid query', { title: longTitle, author: longAuthor }),
        { wrapper: createWrapper() },
      );
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const params = urlParams(MockEventSource.instances[0]!.url);
      expect(params.get('q')).toBe('valid query');
      expect(params.get('title')).toHaveLength(500);
      expect(params.get('author')).toHaveLength(200);
      expect(result.current.state.phase).toBe('searching');
    });

    it('re-fires start() with an edited query while keeping the book-keyed context', async () => {
      const context = { title: 'Real Book', author: 'Real Author', bookDuration: 3600 };
      const { result, rerender } = renderHook(
        ({ q }: { q: string }) => useSearchStream(q, context),
        { wrapper: createWrapper(), initialProps: { q: 'query A' } },
      );
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      expect(urlParams(MockEventSource.instances[0]!.url).get('q')).toBe('query A');

      rerender({ q: 'query B' });
      act(() => { result.current.actions.start(); });

      const params = urlParams(MockEventSource.instances.at(-1)!.url);
      expect(params.get('q')).toBe('query B');
      expect(params.get('title')).toBe('Real Book');
      expect(params.get('author')).toBe('Real Author');
      expect(params.get('bookDuration')).toBe('3600');
    });

    it('recovery reopens the submitted session query, not a mid-search edit (F14)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result, rerender } = renderHook(
        ({ q }: { q: string }) => useSearchStream(q),
        { wrapper: createWrapper(), initialProps: { q: 'query A' } },
      );
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      expect(urlParams(MockEventSource.instances[0]!.url).get('q')).toBe('query A');

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      rerender({ q: 'query B' });
      await act(async () => { deferred.resolve({ token: 'token-2', expiresInMs: 300_000 }); await deferred.promise; });
      await waitFor(() => { expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2); });
      expect(urlParams(MockEventSource.instances.at(-1)!.url).get('q')).toBe('query A');

      act(() => { result.current.actions.start(); });
      expect(urlParams(MockEventSource.instances.at(-1)!.url).get('q')).toBe('query B');
    });

    // Fulfilled remints must not reopen sessions superseded by reset, start, or unmount (F17).
    it('abandons a recovery fulfilled after reset() — no orphan stream (F17)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });
      const countAfterStart = MockEventSource.instances.length;

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      act(() => { result.current.actions.reset(); });

      await act(async () => { deferred.resolve({ token: 'token-2', expiresInMs: 300_000 }); await deferred.promise; });
      expect(MockEventSource.instances.length).toBe(countAfterStart);
      expect(result.current.state.phase).toBe('idle');
    });

    it('abandons a recovery fulfilled after a newer start() — no orphan stream (F17)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      act(() => { result.current.actions.start(); });
      const countAfterNewStart = MockEventSource.instances.length;

      await act(async () => { deferred.resolve({ token: 'token-2', expiresInMs: 300_000 }); await deferred.promise; });
      expect(MockEventSource.instances.length).toBe(countAfterNewStart);
    });

    it('abandons a recovery fulfilled after unmount — no orphan stream (F11)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result, unmount } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      const countBeforeUnmount = MockEventSource.instances.length;
      unmount();

      await act(async () => { deferred.resolve({ token: 'token-2', expiresInMs: 300_000 }); await deferred.promise; });
      expect(MockEventSource.instances.length).toBe(countBeforeUnmount);
    });

    it('a stale remint rejection after reset() does not reintroduce a connection error (F18)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      act(() => { result.current.actions.reset(); });

      await act(async () => { deferred.reject(new Error('mint failed')); await deferred.promise.catch(() => {}); });
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.phase).toBe('idle');
    });

    it('a stale remint rejection after a newer start() does not overwrite the newer session (F3)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise)
        .mockResolvedValue({ token: 'token-live', expiresInMs: 300_000 });

      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      act(() => { result.current.actions.start(); });
      expect(result.current.state.phase).toBe('searching');

      await act(async () => { deferred.reject(new Error('mint failed')); await deferred.promise.catch(() => {}); });
      expect(result.current.state.phase).toBe('searching');
      expect(result.current.state.error).toBeNull();
    });

    // After unmount, only orphan streams and unhandled rejection are observable; state is gone.
    it('a stale remint rejection after unmount is a silent no-op (F3)', async () => {
      const deferred = createDeferred<{ token: string; expiresInMs: number }>();
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockReturnValueOnce(deferred.promise);

      const { result, unmount } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      const countBeforeUnmount = MockEventSource.instances.length;
      unmount();

      await act(async () => { deferred.reject(new Error('mint failed')); await deferred.promise.catch(() => {}); });
      expect(MockEventSource.instances.length).toBe(countBeforeUnmount);
    });

    it('a remint rejection within the live session reaches the generic error state (F18)', async () => {
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockRejectedValueOnce(new Error('mint failed'));

      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: createWrapper() });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      await act(async () => { MockEventSource.instances[0]!.onerror?.(new Event('error')); });
      await waitFor(() => { expect(result.current.state.error).toBe('Search connection failed'); });
      expect(result.current.state.phase).toBe('idle');
    });

    // Numeric generation comparison must survive StrictMode's setup-cleanup-setup probe (F17).
    it('a valid recovery survives the StrictMode probe and reopens (F17)', async () => {
      (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
      (api.mintStreamToken as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 })
        .mockResolvedValueOnce({ token: 'token-2', expiresInMs: 300_000 });

      const strictWrapper = ({ children }: { children: ReactNode }) => (
        <StrictMode>{createWrapper()({ children })}</StrictMode>
      );
      const { result } = renderHook(() => useSearchStream('query A'), { wrapper: strictWrapper });
      await waitForAuth(result);
      act(() => { result.current.actions.start(); });

      const openBefore = MockEventSource.instances.filter(es => !es.closed).length;
      await act(async () => { MockEventSource.instances.at(-1)!.onerror?.(new Event('error')); });
      await waitFor(() => {
        expect(MockEventSource.instances.some(es => es.url.includes('token=token-2') && !es.closed)).toBe(true);
      });
      expect(MockEventSource.instances.filter(es => !es.closed).length).toBe(openBefore);
    });
  });
});
