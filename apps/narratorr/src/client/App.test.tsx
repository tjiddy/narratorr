import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';

// Mock page components to avoid pulling in their dependencies
vi.mock('@/pages/SearchPage', () => ({
  SearchPage: () => <div data-testid="search-page">Search Page</div>,
}));

vi.mock('@/pages/ActivityPage', () => ({
  ActivityPage: () => <div data-testid="activity-page">Activity Page</div>,
}));

vi.mock('@/pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page">Settings Page</div>,
}));

function renderApp(route = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('renders without crashing', () => {
    renderApp('/search');

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('redirects / to /search', () => {
    renderApp('/');

    expect(screen.getByTestId('search-page')).toBeInTheDocument();
  });

  it('renders search page at /search', () => {
    renderApp('/search');

    expect(screen.getByTestId('search-page')).toBeInTheDocument();
  });

  it('renders activity page at /activity', () => {
    renderApp('/activity');

    expect(screen.getByTestId('activity-page')).toBeInTheDocument();
  });

  it('renders settings page at /settings', () => {
    renderApp('/settings');

    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });
});
