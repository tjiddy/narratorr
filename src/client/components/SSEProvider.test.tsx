import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { SSEProvider } from './SSEProvider';
import type { AuthConfig } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getAuthConfig: vi.fn(),
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
  it('does not create an EventSource while auth config query is pending', () => {
    vi.mocked(api.getAuthConfig).mockReturnValue(new Promise(() => {})); // never resolves
    renderProvider();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('passes apiKey to useEventSource when auth config resolves', async () => {
    const authConfig: AuthConfig = { mode: 'forms', apiKey: 'test-api-key', localBypass: false };
    vi.mocked(api.getAuthConfig).mockResolvedValue(authConfig);
    renderProvider();

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    expect(MockEventSource.instances[0]!.url).toContain('apikey=test-api-key');
  });
});
