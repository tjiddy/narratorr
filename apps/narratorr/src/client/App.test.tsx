import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';

// Mock page components to avoid pulling in their dependencies
vi.mock('@/pages/LibraryPage', () => ({
  LibraryPage: () => <div data-testid="library-page">Library Page</div>,
}));

vi.mock('@/pages/SearchPage', () => ({
  SearchPage: () => <div data-testid="search-page">Search Page</div>,
}));

vi.mock('@/pages/ActivityPage', () => ({
  ActivityPage: () => <div data-testid="activity-page">Activity Page</div>,
}));

vi.mock('@/pages/settings', () => ({
  SettingsLayout: () => <div data-testid="settings-page">Settings Page</div>,
  GeneralSettings: () => <div>General</div>,
  IndexersSettings: () => <div>Indexers</div>,
  DownloadClientsSettings: () => <div>Download Clients</div>,
  NotificationsSettings: () => <div>Notifications</div>,
  BlacklistSettings: () => <div>Blacklist</div>,
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
    renderApp('/library');

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('redirects / to /library', () => {
    renderApp('/');

    expect(screen.getByTestId('library-page')).toBeInTheDocument();
  });

  it('renders library page at /library', () => {
    renderApp('/library');

    expect(screen.getByTestId('library-page')).toBeInTheDocument();
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
