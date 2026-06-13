import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { SSEProvider } from './SSEProvider';

// #1453 — SSEProvider mints a short-lived stream token and threads it into
// useEventSource as `?token=`, instead of reading the long-lived API key.
vi.mock('@/lib/api', () => ({
  api: {
    mintStreamToken: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2; }

  simulateError() { this.onerror?.(new Event('error')); }
}

const originalEventSource = globalThis.EventSource;
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});
afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
  vi.clearAllMocks();
});

import { api } from '@/lib/api';

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(QueryClientProvider, { client: queryClient },
      createElement(SSEProvider),
    ),
  );
  return { queryClient };
}

describe('SSEProvider', () => {
  it('does not create an EventSource while the stream-token mint is pending', () => {
    vi.mocked(api.mintStreamToken).mockReturnValue(new Promise(() => {})); // never resolves
    renderProvider();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('mints a stream token and opens the EventSource with ?token= (not ?apikey=)', async () => {
    vi.mocked(api.mintStreamToken).mockResolvedValue({ token: 'minted-token', expiresInMs: 300_000 });
    renderProvider();

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    expect(MockEventSource.instances[0]!.url).toContain('token=minted-token');
    expect(MockEventSource.instances[0]!.url).not.toContain('apikey=');
  });

  it('re-mints and reconnects on a stream error (e.g. token expiry) #1453', async () => {
    // First mint → token1, second mint (after the error-driven refetch) → token2.
    vi.mocked(api.mintStreamToken)
      .mockResolvedValueOnce({ token: 'token1', expiresInMs: 300_000 })
      .mockResolvedValueOnce({ token: 'token2', expiresInMs: 300_000 });

    renderProvider();

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    expect(MockEventSource.instances[0]!.url).toContain('token=token1');

    // Simulate the stream dropping (expired token). The provider should re-mint
    // and reopen with the fresh token rather than failing permanently.
    act(() => { MockEventSource.instances[0]!.simulateError(); });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });
    expect(api.mintStreamToken).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances.at(-1)!.url).toContain('token=token2');
  });
});
