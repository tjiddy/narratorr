import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';

// Mock AuthProvider as pass-through (avoids API calls from useAuth)
vi.mock('@/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock hooks used by Layout
vi.mock('@/hooks/useActivityCounts', () => ({
  useActivityCounts: () => ({ active: 0, completed: 0, isLoading: false }),
}));

vi.mock('@/hooks/useAuthContext', () => ({
  useAuthContext: () => ({
    mode: 'none',
    hasUser: false,
    localBypass: false,
    bypassActive: false,
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

// Mock page components to avoid pulling in their dependencies
vi.mock('@/pages/login', () => ({
  LoginPage: () => <div data-testid="login-page">Login Page</div>,
}));

vi.mock('@/pages/library', () => ({
  LibraryPage: () => <div data-testid="library-page">Library Page</div>,
}));

vi.mock('@/pages/search', () => ({
  SearchPage: () => <div data-testid="search-page">Search Page</div>,
}));

vi.mock('@/pages/activity', () => ({
  ActivityPage: () => <div data-testid="activity-page">Activity Page</div>,
}));

vi.mock('@/pages/discover', () => ({
  DiscoverPage: () => <div data-testid="discover-page">Discover Page</div>,
}));

vi.mock('@/pages/settings', () => ({
  SettingsLayout: () => <div data-testid="settings-page">Settings Page<Outlet /></div>,
}));

vi.mock('./pages/library-import/LibraryImportPage.js', () => ({
  LibraryImportPage: () => <div data-testid="library-import-page">Library Import Page</div>,
}));

// Mock the settings page registry used by App.tsx for route generation
vi.mock('@/pages/settings/registry', () => {
  const icon = () => null;
  return {
    settingsPageRegistry: [
      { path: '', label: 'General', icon, component: () => <div>General</div>, end: true },
      { path: 'indexers', label: 'Indexers', icon, component: () => <div>Indexers</div> },
      { path: 'download-clients', label: 'Download Clients', icon, component: () => <div>Download Clients</div> },
      { path: 'search', label: 'Search', icon, component: () => <div>Search Settings</div> },
      { path: 'notifications', label: 'Notifications', icon, component: () => <div>Notifications</div> },
      { path: 'blacklist', label: 'Blacklist', icon, component: () => <div>Blacklist</div> },
      { path: 'security', label: 'Security', icon, component: () => <div>Security</div> },
      { path: 'import-lists', label: 'Import Lists', icon, component: () => <div>Import Lists</div> },
      { path: 'system', label: 'System', icon, component: () => <div>System</div> },
    ],
  };
});

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

  it('renders discover page at /discover', () => {
    renderApp('/discover');

    expect(screen.getByTestId('discover-page')).toBeInTheDocument();
  });

  it('renders settings page at /settings', () => {
    renderApp('/settings');

    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('renders system settings page at /settings/system', () => {
    renderApp('/settings/system');

    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('renders library import page at /library-import', () => {
    renderApp('/library-import');

    expect(screen.getByTestId('library-import-page')).toBeInTheDocument();
  });

  // #550 — missing route coverage
  it.todo('renders login page at /login');
  it.todo('renders book page at /books/:id');
  it.todo('renders author page at /authors/:asin');
  it.todo('renders manual import page at /import');

  // #550 — lazy loading / Suspense behavior
  it.todo('shows loading spinner while lazy chunk loads');
  it.todo('route-scoped error boundary catches chunk load failure');
  it.todo('other routes remain navigable after one chunk fails');
  it.todo('redirect from / to /library works with lazy-loaded page');
});
