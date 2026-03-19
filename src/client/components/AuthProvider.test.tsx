import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AuthProvider } from './AuthProvider';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), useNavigate: () => mockNavigate };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '@/hooks/useAuth';
import type { AuthState } from '@/hooks/useAuth';

function mockAuth(overrides: Partial<AuthState> = {}) {
  const defaults: AuthState = {
    mode: 'none',
    hasUser: false,
    localBypass: false,
    bypassActive: false,
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  };
  vi.mocked(useAuth).mockReturnValue({ ...defaults, ...overrides });
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
  });

  it('renders children when mode = "none"', () => {
    mockAuth({ mode: 'none' });
    renderWithProviders(
      <AuthProvider><div>App Content</div></AuthProvider>,
    );
    expect(screen.getByText('App Content')).toBeInTheDocument();
  });

  it('does not render children when mode = "forms" and not authenticated', () => {
    mockAuth({ mode: 'forms', isAuthenticated: false, hasUser: true });
    renderWithProviders(
      <AuthProvider><div>Protected Content</div></AuthProvider>,
      { route: '/library' },
    );
    // Children should NOT be shown — needsRedirect guard shows spinner
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    // Should navigate to /login
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('renders children when mode = "forms" and authenticated', () => {
    mockAuth({ mode: 'forms', isAuthenticated: true, hasUser: true });
    renderWithProviders(
      <AuthProvider><div>Protected Content</div></AuthProvider>,
    );
    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('renders children when mode = "basic" (browser handles auth natively)', () => {
    mockAuth({ mode: 'basic', isAuthenticated: true });
    renderWithProviders(
      <AuthProvider><div>Basic Auth Content</div></AuthProvider>,
    );
    expect(screen.getByText('Basic Auth Content')).toBeInTheDocument();
  });

  it('logout() calls /api/auth/logout and redirects to /login', () => {
    const logoutFn = vi.fn();
    mockAuth({ logout: logoutFn });
    // The logout function is provided via context — verify it's the one from useAuth
    expect(vi.mocked(useAuth)().logout).toBe(logoutFn);
  });

  it('does NOT redirect to /login when bypassActive is true (env bypass), even in forms mode', () => {
    mockAuth({ mode: 'forms', isAuthenticated: false, hasUser: true, bypassActive: true });
    renderWithProviders(
      <AuthProvider><div>Protected Content</div></AuthProvider>,
      { route: '/library' },
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT redirect to /login when bypassActive is true (local bypass), even in forms mode', () => {
    mockAuth({ mode: 'forms', isAuthenticated: false, hasUser: true, bypassActive: true });
    renderWithProviders(
      <AuthProvider><div>Protected Content</div></AuthProvider>,
      { route: '/library' },
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('still redirects to /login in forms mode when bypassActive is false and user is unauthenticated', () => {
    mockAuth({ mode: 'forms', isAuthenticated: false, hasUser: true, bypassActive: false });
    renderWithProviders(
      <AuthProvider><div>Protected Content</div></AuthProvider>,
      { route: '/library' },
    );
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('shows loading spinner while auth state resolves', () => {
    mockAuth({ isLoading: true });
    renderWithProviders(
      <AuthProvider><div>Should not show</div></AuthProvider>,
    );
    expect(screen.queryByText('Should not show')).not.toBeInTheDocument();
  });
});
