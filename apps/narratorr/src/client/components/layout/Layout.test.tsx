import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { Layout } from '@/components/layout/Layout';

vi.mock('@/hooks/useActivityCounts', () => ({
  useActivityCounts: vi.fn(),
}));

import { useActivityCounts } from '@/hooks/useActivityCounts';

describe('Layout', () => {
  function mockCounts(active: number) {
    (useActivityCounts as any).mockReturnValue({
      active,
      completed: 0,
      isLoading: false,
    });
  }

  it('renders without crashing', () => {
    mockCounts(0);
    renderWithProviders(<Layout />);

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    mockCounts(0);
    renderWithProviders(<Layout />);

    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders footer', () => {
    mockCounts(0);
    renderWithProviders(<Layout />);

    expect(screen.getByText(/your personal audiobook library/i)).toBeInTheDocument();
  });

  it('renders theme toggle button', () => {
    mockCounts(0);
    renderWithProviders(<Layout />);

    expect(screen.getByTitle(/switch to dark mode/i)).toBeInTheDocument();
  });

  it('shows badge when active downloads > 0', () => {
    mockCounts(4);
    renderWithProviders(<Layout />, { route: '/search' });

    const badge = screen.getByLabelText('4 active downloads');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('4');
  });

  it('hides badge when active downloads is 0', () => {
    mockCounts(0);
    renderWithProviders(<Layout />);

    expect(screen.queryByLabelText(/active download/)).not.toBeInTheDocument();
  });

  it('uses singular label for 1 active download', () => {
    mockCounts(1);
    renderWithProviders(<Layout />, { route: '/search' });

    expect(screen.getByLabelText('1 active download')).toBeInTheDocument();
  });
});
