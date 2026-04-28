import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useAuth } from './useAuth';

vi.mock('@/lib/api', () => ({
  api: {
    getAuthStatus: vi.fn(),
    getAuthAdminStatus: vi.fn(),
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

  it('exposes bypassActive from authenticated admin status', async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({ mode: 'forms', authenticated: true });
    vi.mocked(api.getAuthAdminStatus).mockResolvedValue({
      hasUser: true,
      localBypass: false,
      bypassActive: true,
      envBypass: false,
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.bypassActive).toBe(true));
  });

  it('defaults bypassActive to false while loading', () => {
    vi.mocked(api.getAuthStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getAuthAdminStatus).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    expect(result.current.bypassActive).toBe(false);
  });

  it('returns combined auth state from public + admin endpoints', async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({ mode: 'forms', authenticated: true });
    vi.mocked(api.getAuthAdminStatus).mockResolvedValue({
      hasUser: true,
      localBypass: false,
      bypassActive: false,
      envBypass: false,
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.hasUser).toBe(true));

    expect(result.current.mode).toBe('forms');
    expect(result.current.localBypass).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('does not query admin status when unauthenticated (forms mode pre-login)', async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({ mode: 'forms', authenticated: false });
    vi.mocked(api.getAuthAdminStatus).mockResolvedValue({
      hasUser: true,
      localBypass: false,
      bypassActive: false,
      envBypass: false,
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(api.getAuthAdminStatus).not.toHaveBeenCalled();
    // Admin-only fields default to safe values when not yet authenticated.
    expect(result.current.hasUser).toBe(false);
    expect(result.current.localBypass).toBe(false);
    expect(result.current.bypassActive).toBe(false);
  });

  it('defaults to safe values while loading', () => {
    vi.mocked(api.getAuthStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getAuthAdminStatus).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.mode).toBe('none');
    expect(result.current.hasUser).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('authLogout calls API, invalidates auth cache, and redirects to /login', async () => {
    vi.mocked(api.getAuthStatus)
      .mockResolvedValueOnce({ mode: 'forms', authenticated: true })
      .mockResolvedValue({ mode: 'forms', authenticated: false });
    vi.mocked(api.getAuthAdminStatus).mockResolvedValue({
      hasUser: true,
      localBypass: false,
      bypassActive: false,
      envBypass: false,
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

    expect(queryClient.getQueryData(['auth', 'status'])).toBeTruthy();

    await act(async () => {
      await result.current.logout();
    });

    expect(api.authLogout).toHaveBeenCalled();
    expect(api.getAuthStatus).toHaveBeenCalledTimes(2);
    const cachedStatus = queryClient.getQueryData(['auth', 'status']) as { authenticated: boolean } | undefined;
    expect(cachedStatus?.authenticated).toBe(false);
    expect(window.location.href).toBe('/login');
  });

  it('authLogout redirects to {URL_BASE}/login when URL_BASE is set', async () => {
    window.__NARRATORR_URL_BASE__ = '/narratorr';
    vi.resetModules();

    const { useAuth: useAuthWithBase } = await import('./useAuth');
    const freshApi = (await import('@/lib/api')).api;
    vi.mocked(freshApi.getAuthStatus)
      .mockResolvedValueOnce({ mode: 'forms', authenticated: true })
      .mockResolvedValue({ mode: 'forms', authenticated: false });
    vi.mocked(freshApi.getAuthAdminStatus).mockResolvedValue({
      hasUser: true,
      localBypass: false,
      bypassActive: false,
      envBypass: false,
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
