import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSearchStream } from './useSearchStream';
import type { DownloadProtocol } from '../../core/indexers/types.js';

// Mock api — streams authenticate via a minted stream token (#1453), not the API key.
vi.mock('@/lib/api', () => ({
  api: {
    mintStreamToken: vi.fn().mockResolvedValue({ token: 'test-stream-token', expiresInMs: 300_000 }),
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
    // Reset mock to default resolved value
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'test-stream-token', expiresInMs: 300_000 });
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

    // Server-parity OR-match: a dual-identifier row is removed by EITHER identifier
    // on its own. Dropping the infoHash clause from the matcher fails this case.
    it('removes a dual-identifier row matched by its infoHash alone', async () => {
      const result = await startWithResults([
        { title: 'Dual D', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashD', guid: 'guidD' },
        { title: 'Control', indexer: 'NZB', protocol: 'usenet', guid: 'guidZ' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: 'hashD' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    // Dropping the guid clause from the matcher fails this case.
    it('removes a dual-identifier row matched by its guid alone', async () => {
      const result = await startWithResults([
        { title: 'Dual D', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashD', guid: 'guidD' },
        { title: 'Control', indexer: 'NZB', protocol: 'usenet', guid: 'guidZ' },
      ]);

      act(() => { result.current.actions.removeResult({ guid: 'guidD' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    // Guid-sibling seam (the named user-visible behavior change): blacklisting a
    // dual-identifier row also removes a distinct sibling sharing only its guid.
    // The old coalesced-primary filter left the sibling visible.
    it('removes a guid-only sibling sharing the blacklisted row guid', async () => {
      const result = await startWithResults([
        { title: 'Dual A', indexer: 'ABB', protocol: 'torrent', infoHash: 'hashA', guid: 'guidA' },
        { title: 'Guid Sibling', indexer: 'NZB', protocol: 'usenet', guid: 'guidA' },
        { title: 'Control', indexer: 'MAM', protocol: 'torrent', infoHash: 'hashZ' },
      ]);

      // The modal passes the dual row's identifiers; the sibling matches on guid.
      act(() => { result.current.actions.removeResult({ infoHash: 'hashA', guid: 'guidA' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Control']);
    });

    // Empty-string identifiers must contribute nothing (truthiness guard, not
    // `!= null`). A `!= null` infoHash guard would match both empty-infoHash rows
    // and wrongly remove the guidY row.
    it('treats an empty-string identifier as a non-match', async () => {
      const result = await startWithResults([
        { title: 'Empty X', indexer: 'NZB', protocol: 'usenet', infoHash: '', guid: 'guidX' },
        { title: 'Empty Y', indexer: 'NZB', protocol: 'usenet', infoHash: '', guid: 'guidY' },
      ]);

      act(() => { result.current.actions.removeResult({ infoHash: '', guid: 'guidX' }); });

      expect(result.current.state.results?.results.map(r => r.title)).toEqual(['Empty Y']);
    });

    // Intentional Array.filter semantics: one call removes every row sharing the
    // identity, mirroring server-side content-identity blacklisting. A future
    // findIndex+splice "fix" would regress this visibly.
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
      // Same reference — unchanged set, no spurious re-render churn.
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

    // Optimistically marked as cancelled
    expect(result.current.state.indexers[0]!.status).toBe('cancelled');
    // Other indexer unchanged
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

  // #1453 / F3 — a stream error during an active search is most likely an expired
  // stream token; the hook must re-mint a fresh token and reconnect transparently
  // rather than surfacing a terminal failure.
  it('re-mints and reconnects on a stream error (token expiry) instead of failing permanently', async () => {
    // mockClear (not the queue-draining resets) zeroes the call history accumulated
    // by earlier tests' query mounts while preserving the Once queue below, so the
    // absolute toHaveBeenCalledTimes assertion counts only this test's mints.
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockClear();
    (api.mintStreamToken as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ token: 'token-1', expiresInMs: 300_000 }) // query mount
      .mockResolvedValueOnce({ token: 'token-2', expiresInMs: 300_000 }); // remint on error

    const { result } = renderHook(() => useSearchStream('test query'), { wrapper: createWrapper() });

    await waitForAuth(result);
    act(() => {
      result.current.actions.start();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toContain('token=token-1');

    // Active-search stream error → transparent re-mint + reconnect.
    await act(async () => {
      MockEventSource.instances[0]!.onerror?.(new Event('error'));
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    // mintStreamToken called again, new EventSource opened with the fresh ?token=.
    expect(api.mintStreamToken).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances.at(-1)!.url).toContain('token=token-2');
    // Connection recovered — not surfaced as a user-visible failure.
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

    // First error → re-mint + reconnect.
    await act(async () => {
      MockEventSource.instances[0]!.onerror?.(new Event('error'));
    });
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    // Second error on the reconnected stream → terminal failure, no further remint.
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

    // Phase transitions to results IMMEDIATELY — doesn't wait for search-complete
    expect(result.current.state.phase).toBe('results');
    // Pending indexer was cancelled
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

    // Only indexer 2 is cancelled
    expect(result.current.state.indexers[0]!.status).toBe('pending');
    expect(result.current.state.indexers[1]!.status).toBe('cancelled');
    expect(result.current.state.indexers[2]!.status).toBe('pending');
  });

  it('does not open EventSource when the stream token is not yet minted', () => {
    // Override mock to return pending promise (never resolves during this test)
    (api.mintStreamToken as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

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

      // Wait for real timeout to fire
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

      // search-complete arrives before timeout
      act(() => {
        es!.emit('search-complete', { results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } });
      });

      expect(result.current.state.results).not.toBeNull();
      expect(result.current.state.phase).toBe('results');
      expect(result.current.state.error).toBeNull();

      // Wait past timeout — should NOT trigger error
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

      // Wait for timeout
      await waitFor(() => {
        expect(result.current.state.phase).toBe('idle');
      });
      expect(result.current.state.error).toBeTruthy();

      // Retry
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

      // SSE connection drops while finalizing
      act(() => {
        if (es!.onerror) es!.onerror(new Event('error'));
      });

      expect(result.current.state.error).toBe('Search connection failed');
      expect(result.current.state.phase).toBe('idle');
    });
  });

  describe('SSE payload validation', () => {
    /**
     * Helper to start the hook with a primed search-start event so handlers
     * have an indexer list to mutate. Returns the rendered hook + EventSource.
     */
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

      // Missing indexers field
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

      // Missing `error` field
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

      // indexerId as string violates schema
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

      // Verify the finalizing timeout was cleared — the late timeout callback
      // would otherwise overwrite our error to 'Search timed out…'.
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

      // Missing `protocol` field on the result violates searchResultSchema
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

      // 999 is not in the original session indexers — schema passes, no row matches
      act(() => {
        es!.emit('indexer-complete', { indexerId: 999, name: 'Phantom', resultCount: 5, elapsedMs: 100 });
      });

      expect(result.current.state.indexers[0]!.status).toBe('pending');
      expect(result.current.state.indexers[1]!.status).toBe('pending');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
