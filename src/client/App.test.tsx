import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';

vi.mock('@/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

vi.mock('@/pages/book', () => ({
  BookPage: () => <div data-testid="book-page">Book Page</div>,
}));

vi.mock('@/pages/author', () => ({
  AuthorPage: () => <div data-testid="author-page">Author Page</div>,
}));

vi.mock('@/pages/manual-import', () => ({
  ManualImportPage: () => <div data-testid="manual-import-page">Manual Import Page</div>,
}));

vi.mock('@/pages/settings', () => ({
  SettingsLayout: () => <div data-testid="settings-page">Settings Page</div>,
}));

vi.mock('./pages/library-import/LibraryImportPage.js', () => ({
  LibraryImportPage: () => <div data-testid="library-import-page">Library Import Page</div>,
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
  it('renders without crashing', async () => {
    renderApp('/library');

    await waitFor(() => {
      expect(screen.getByText('narratorr')).toBeInTheDocument();
    });
  });

  it('redirects / to /library', async () => {
    renderApp('/');

    await waitFor(() => {
      expect(screen.getByTestId('library-page')).toBeInTheDocument();
    });
  });

  it('renders library page at /library', async () => {
    renderApp('/library');

    await waitFor(() => {
      expect(screen.getByTestId('library-page')).toBeInTheDocument();
    });
  });

  it('renders search page at /search', async () => {
    renderApp('/search');

    await waitFor(() => {
      expect(screen.getByTestId('search-page')).toBeInTheDocument();
    });
  });

  it('renders activity page at /activity', async () => {
    renderApp('/activity');

    await waitFor(() => {
      expect(screen.getByTestId('activity-page')).toBeInTheDocument();
    });
  });

  it('renders discover page at /discover', async () => {
    renderApp('/discover');

    await waitFor(() => {
      expect(screen.getByTestId('discover-page')).toBeInTheDocument();
    });
  });

  it('renders settings page at /settings', async () => {
    renderApp('/settings');

    await waitFor(() => {
      expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    });
  });

  it('renders library import page at /library-import', async () => {
    renderApp('/library-import');

    await waitFor(() => {
      expect(screen.getByTestId('library-import-page')).toBeInTheDocument();
    });
  });

  it('renders login page at /login', async () => {
    renderApp('/login');

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('renders book page at /books/:id', async () => {
    renderApp('/books/42');

    await waitFor(() => {
      expect(screen.getByTestId('book-page')).toBeInTheDocument();
    });
  });

  it('renders author page at /authors/:asin', async () => {
    renderApp('/authors/B001H6KJBC');

    await waitFor(() => {
      expect(screen.getByTestId('author-page')).toBeInTheDocument();
    });
  });

  it('renders manual import page at /import', async () => {
    renderApp('/import');

    await waitFor(() => {
      expect(screen.getByTestId('manual-import-page')).toBeInTheDocument();
    });
  });

  it('layout shell remains mounted while lazy page loads', async () => {
    renderApp('/library');

    expect(screen.getByText('narratorr')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('library-page')).toBeInTheDocument();
    });

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });
});
