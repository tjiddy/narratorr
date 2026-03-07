import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { Layout } from '@/components/layout/Layout';

vi.mock('@/hooks/useActivityCounts', () => ({
  useActivityCounts: vi.fn(),
}));

vi.mock('@/hooks/useAuthContext', () => ({
  useAuthContext: vi.fn(),
}));

import { useActivityCounts } from '@/hooks/useActivityCounts';
import { useAuthContext } from '@/hooks/useAuthContext';

describe('Layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function mockCounts(active: number) {
    vi.mocked(useActivityCounts).mockReturnValue({
      active,
      completed: 0,
      isLoading: false,
    });
  }

  function mockAuth(mode: 'none' | 'basic' | 'forms' = 'none') {
    vi.mocked(useAuthContext).mockReturnValue({
      mode,
      hasUser: mode !== 'none',
      localBypass: false,
      isAuthenticated: true,
      isLoading: false,
      logout: vi.fn(),
    });
  }

  it('renders without crashing', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders footer', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.getByText(/your personal audiobook library/i)).toBeInTheDocument();
  });

  it('renders theme toggle button', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.getByTitle(/switch to dark mode/i)).toBeInTheDocument();
  });

  it('shows badge when active downloads > 0', () => {
    mockCounts(4);
    mockAuth();
    renderWithProviders(<Layout />, { route: '/search' });

    const badge = screen.getByLabelText('4 active downloads');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('4');
  });

  it('hides badge when active downloads is 0', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.queryByLabelText(/active download/)).not.toBeInTheDocument();
  });

  it('uses singular label for 1 active download', () => {
    mockCounts(1);
    mockAuth();
    renderWithProviders(<Layout />, { route: '/search' });

    expect(screen.getByLabelText('1 active download')).toBeInTheDocument();
  });

  it('toggles theme on button click', async () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    const toggleButton = screen.getByTitle(/switch to dark mode/i);
    await userEvent.click(toggleButton);

    expect(screen.getByTitle(/switch to light mode/i)).toBeInTheDocument();
  });

  describe('auth warning banner', () => {
    it('banner visible when mode = "none"', () => {
      mockCounts(0);
      mockAuth('none');
      renderWithProviders(<Layout />);

      expect(screen.getByText(/authentication is disabled/i)).toBeInTheDocument();
      expect(screen.getByText(/settings > security/i)).toBeInTheDocument();
    });

    it('banner hidden when mode = "forms" or "basic"', () => {
      mockCounts(0);
      mockAuth('forms');
      renderWithProviders(<Layout />);

      expect(screen.queryByText(/authentication is disabled/i)).not.toBeInTheDocument();
    });

    it('dismiss banner → hidden, persists on reload (localStorage mock)', async () => {
      mockCounts(0);
      mockAuth('none');
      const user = userEvent.setup();

      const { unmount } = renderWithProviders(<Layout />);
      expect(screen.getByText(/authentication is disabled/i)).toBeInTheDocument();

      // Dismiss the banner
      const dismissButton = screen.getByLabelText('Dismiss auth warning');
      await user.click(dismissButton);

      expect(screen.queryByText(/authentication is disabled/i)).not.toBeInTheDocument();
      expect(localStorage.getItem('narratorr:auth-banner-dismissed')).toBe('true');

      // Re-render — banner should stay dismissed
      unmount();
      renderWithProviders(<Layout />);
      expect(screen.queryByText(/authentication is disabled/i)).not.toBeInTheDocument();
    });
  });
});
