import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useAuth } from './useAuth';

vi.mock('@/lib/api', () => ({
  api: {
    getAuthStatus: vi.fn(),
    authLogout: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useAuth', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.location for redirect assertion
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, href: 'http://localhost/' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
    delete window.__NARRATORR_URL_BASE__;
    vi.resetModules();
  });

  it('exposes bypassActive from auth status', async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      mode: 'forms',
      hasUser: true,
      localBypass: false,
      authenticated: false,
      bypassActive: true,
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bypassActive).toBe(true);
  });

  it('defaults bypassActive to false while loading', () => {
    vi.mocked(api.getAuthStatus).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    expect(result.current.bypassActive).toBe(false);
  });

  it('returns auth status from API', async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      mode: 'forms',
      hasUser: true,
      localBypass: false,
      authenticated: true,
      bypassActive: false,
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.mode).toBe('forms');
    expect(result.current.hasUser).toBe(true);
    expect(result.current.localBypass).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('defaults to safe values while loading', () => {
    vi.mocked(api.getAuthStatus).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.mode).toBe('none');
    expect(result.current.hasUser).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('authLogout calls API, invalidates auth cache, and redirects to /login', async () => {
    // First call (mount) returns authenticated, second call (post-invalidation) returns unauthenticated
    vi.mocked(api.getAuthStatus)
      .mockResolvedValueOnce({
        mode: 'forms',
        hasUser: true,
        localBypass: false,
        authenticated: true,
      })
      .mockResolvedValue({
        mode: 'forms',
        hasUser: true,
        localBypass: false,
        authenticated: false,
      });
    vi.mocked(api.authLogout).mockResolvedValue(undefined as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Auth status should be cached before authLogout
    expect(queryClient.getQueryData(['auth', 'status'])).toBeTruthy();

    await act(async () => {
      await result.current.logout();
    });

    expect(api.authLogout).toHaveBeenCalled();
    // invalidateQueries triggers a refetch — getAuthStatus called again with post-authLogout state
    expect(api.getAuthStatus).toHaveBeenCalledTimes(2);
    // Cache now reflects unauthenticated state (from the refetch after invalidation)
    const cachedStatus = queryClient.getQueryData(['auth', 'status']) as { authenticated: boolean } | undefined;
    expect(cachedStatus?.authenticated).toBe(false);
    expect(window.location.href).toBe('/login');
  });

  it('authLogout redirects to {URL_BASE}/login when URL_BASE is set', async () => {
    // Set URL_BASE before re-importing the hook
    window.__NARRATORR_URL_BASE__ = '/narratorr';
    vi.resetModules();

    // Re-import with the new URL_BASE value
    const { useAuth: useAuthWithBase } = await import('./useAuth');
    const freshApi = (await import('@/lib/api')).api;
    vi.mocked(freshApi.getAuthStatus).mockResolvedValueOnce({
      mode: 'forms',
      hasUser: true,
      localBypass: false,
      authenticated: true,
    }).mockResolvedValue({
      mode: 'forms',
      hasUser: true,
      localBypass: false,
      authenticated: false,
    });
    vi.mocked(freshApi.authLogout).mockResolvedValue(undefined as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useAuthWithBase(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(window.location.href).toBe('/narratorr/login');
  });
});
