import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { Layout } from '@/components/layout/Layout';

vi.mock('@/hooks/useActivityCounts', () => ({
  useActivityCounts: vi.fn(),
}));

vi.mock('@/hooks/useAuthContext', () => ({
  useAuthContext: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getHealthSummary: vi.fn().mockResolvedValue({ state: 'healthy' }),
    getSystemStatus: vi.fn(),
    dismissUpdate: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

import { useActivityCounts } from '@/hooks/useActivityCounts';
import { useAuthContext } from '@/hooks/useAuthContext';
const { api } = await import('@/lib/api');
const mockApi = api as unknown as { getHealthSummary: ReturnType<typeof vi.fn> };

describe('Layout', () => {
  beforeEach(() => {
    localStorage.clear();
    // Default: welcomeSeen: true so the welcome modal does not appear in unrelated tests
    vi.mocked(api.getSettings).mockResolvedValue(
      createMockSettings({ general: { welcomeSeen: true } }),
    );
    vi.mocked(api.updateSettings).mockResolvedValue(
      createMockSettings({ general: { welcomeSeen: true } }),
    );
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
      bypassActive: false,
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
    expect(screen.getByText('Add Book')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders PlusIcon for the Add Book nav item (not SearchIcon)', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    const addBookLink = screen.getByRole('link', { name: /add book/i });
    // PlusIcon has straight-line paths; SearchIcon has a <circle> — regression to SearchIcon fails this
    expect(addBookLink.querySelector('circle')).toBeNull();
    const paths = Array.from(addBookLink.querySelectorAll('path'));
    expect(paths.some(p => p.getAttribute('d') === 'M5 12h14')).toBe(true);
  });

  it('does not render theme toggle button in nav bar', () => {
    mockCounts(0);
    mockAuth();
    renderWithProviders(<Layout />);

    expect(screen.queryByTitle(/switch to dark mode/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/switch to light mode/i)).not.toBeInTheDocument();
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

  describe('health indicator wiring', () => {
    it('renders HealthIndicator in the navbar when health is in error state', async () => {
      mockCounts(0);
      mockAuth('forms');
      mockApi.getHealthSummary.mockResolvedValue({ state: 'error' });

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByTestId('health-indicator')).toBeInTheDocument();
      });
    });
  });

  describe('discover nav integration', () => {
    it('shows Discover nav item when discovery setting is enabled', async () => {
      mockCounts(0);
      mockAuth('forms');
      vi.mocked(api.getSettings).mockResolvedValue(createMockSettings({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } }));

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByText('Discover')).toBeInTheDocument();
      });
    });

    it('renders Discover nav item between Search and Activity when enabled', async () => {
      mockCounts(0);
      mockAuth('forms');
      vi.mocked(api.getSettings).mockResolvedValue(createMockSettings({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } }));

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByText('Discover')).toBeInTheDocument();
      });

      const navLabels = screen.getAllByRole('link')
        .map((el) => el.textContent?.trim())
        .filter((t) => ['Library', 'Add Book', 'Discover', 'Activity', 'Settings'].includes(t ?? ''));

      expect(navLabels).toEqual(['Library', 'Add Book', 'Discover', 'Activity', 'Settings']);
    });

    it('hides Discover nav item when discovery setting is disabled', async () => {
      mockCounts(0);
      mockAuth('forms');
      vi.mocked(api.getSettings).mockResolvedValue(createMockSettings());

      renderWithProviders(<Layout />);

      // Wait for settings query to settle
      await waitFor(() => {
        expect(screen.getByText('Library')).toBeInTheDocument();
      });
      expect(screen.queryByText('Discover')).not.toBeInTheDocument();

      const navLabels = screen.getAllByRole('link')
        .map((el) => el.textContent?.trim())
        .filter((t) => ['Library', 'Add Book', 'Discover', 'Activity', 'Settings'].includes(t ?? ''));

      expect(navLabels).toEqual(['Library', 'Add Book', 'Activity', 'Settings']);
    });

    it('hides Discover nav item when settings query is still loading', () => {
      mockCounts(0);
      mockAuth('forms');
      vi.mocked(api.getSettings).mockReturnValue(new Promise(() => {})); // never resolves

      renderWithProviders(<Layout />);

      expect(screen.queryByText('Discover')).not.toBeInTheDocument();
    });

    it('HealthIndicator follows Settings link and is the final nav control (discovery disabled)', async () => {
      mockCounts(0);
      mockAuth('forms');
      mockApi.getHealthSummary.mockResolvedValue({ state: 'error' });
      vi.mocked(api.getSettings).mockResolvedValue(createMockSettings());

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByTestId('health-indicator')).toBeInTheDocument();
      });

      const nav = screen.getByRole('navigation');
      const settingsLink = screen.getByRole('link', { name: /^settings$/i });
      const healthIndicator = screen.getByTestId('health-indicator');

      // HealthIndicator must follow Settings link in DOM order
      expect(
        settingsLink.compareDocumentPosition(healthIndicator) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // HealthIndicator must be the final interactive nav control — no trailing control after it
      const interactiveControls = Array.from(nav.querySelectorAll('a, button'));
      expect(interactiveControls[interactiveControls.length - 1]).toBe(healthIndicator);
    });

    it('HealthIndicator follows Settings link and is the final nav control (discovery enabled)', async () => {
      mockCounts(0);
      mockAuth('forms');
      mockApi.getHealthSummary.mockResolvedValue({ state: 'error' });
      vi.mocked(api.getSettings).mockResolvedValue(
        createMockSettings({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } }),
      );

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByTestId('health-indicator')).toBeInTheDocument();
      });

      const nav = screen.getByRole('navigation');
      const settingsLink = screen.getByRole('link', { name: /^settings$/i });
      const healthIndicator = screen.getByTestId('health-indicator');

      // HealthIndicator must follow Settings link in DOM order
      expect(
        settingsLink.compareDocumentPosition(healthIndicator) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // HealthIndicator must be the final interactive nav control — no trailing control after it
      const interactiveControls = Array.from(nav.querySelectorAll('a, button'));
      expect(interactiveControls[interactiveControls.length - 1]).toBe(healthIndicator);
    });
  });

  describe('update banner integration', () => {
    it('renders update banner in the shell when API reports an available update', async () => {
      mockCounts(0);
      mockAuth('forms');
      vi.mocked(api.getSystemStatus).mockResolvedValue({
        version: '0.1.0',
        status: 'ok',
        timestamp: new Date().toISOString(),
        update: {
          latestVersion: '0.2.0',
          releaseUrl: 'https://github.com/releases/v0.2.0',
          dismissed: false,
        },
      });

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByText(/update available/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    });
  });

  describe('#99 footer removal and flex layout contract', () => {
    it('renders no footer text anywhere in the DOM', () => {
      mockCounts(0);
      mockAuth();
      const { container } = renderWithProviders(<Layout />);

      expect(container.querySelector('footer')).toBeNull();
      expect(screen.queryByText(/your personal audiobook library/i)).not.toBeInTheDocument();
    });

    it('root layout div has flex and flex-col classes', () => {
      mockCounts(0);
      mockAuth();
      const { container } = renderWithProviders(<Layout />);

      const root = container.firstChild as HTMLElement;
      expect(root.classList.contains('flex')).toBe(true);
      expect(root.classList.contains('flex-col')).toBe(true);
      expect(root.classList.contains('min-h-screen')).toBe(true);
    });

    it('main content element has flex-1 class', () => {
      mockCounts(0);
      mockAuth();
      const { container } = renderWithProviders(<Layout />);

      const main = container.querySelector('main') as HTMLElement;
      expect(main).not.toBeNull();
      expect(main.classList.contains('flex-1')).toBe(true);
    });

    it('main content element has w-full class to prevent shrink-wrap in flex-col container', () => {
      mockCounts(0);
      mockAuth();
      const { container } = renderWithProviders(<Layout />);

      const main = container.querySelector('main') as HTMLElement;
      expect(main).not.toBeNull();
      expect(main.classList.contains('w-full')).toBe(true);
    });

    function renderWithNestedRoute(path: string, testId: string) {
      mockCounts(0);
      mockAuth();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route path="library" element={<div data-testid={testId}>Library Content</div>} />
                <Route path="activity" element={<div data-testid={testId}>Activity Content</div>} />
                <Route path="settings" element={<div data-testid={testId}>Settings Content</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    it('renders route content inside main on /library route with no footer text', () => {
      const { container } = renderWithNestedRoute('/library', 'library-content');

      expect(screen.getByRole('navigation')).toBeInTheDocument();
      expect(screen.queryByText(/your personal audiobook library/i)).not.toBeInTheDocument();
      const main = container.querySelector('main');
      expect(main).not.toBeNull();
      expect(main!.querySelector('[data-testid="library-content"]')).not.toBeNull();
    });

    it('renders route content inside main on /activity route with no footer text', () => {
      const { container } = renderWithNestedRoute('/activity', 'activity-content');

      expect(screen.getByRole('navigation')).toBeInTheDocument();
      expect(screen.queryByText(/your personal audiobook library/i)).not.toBeInTheDocument();
      const main = container.querySelector('main');
      expect(main).not.toBeNull();
      expect(main!.querySelector('[data-testid="activity-content"]')).not.toBeNull();
    });

    it('renders route content inside main on /settings route with no footer text', () => {
      const { container } = renderWithNestedRoute('/settings', 'settings-content');

      expect(screen.getByRole('navigation')).toBeInTheDocument();
      expect(screen.queryByText(/your personal audiobook library/i)).not.toBeInTheDocument();
      const main = container.querySelector('main');
      expect(main).not.toBeNull();
      expect(main!.querySelector('[data-testid="settings-content"]')).not.toBeNull();
    });
  });

  describe('z-index scale', () => {
    it('header has z-10 class (sticky header scale)', () => {
      mockCounts(0);
      mockAuth();
      const { container } = renderWithProviders(<Layout />);
      const header = container.querySelector('header');
      expect(header).not.toBeNull();
      expect(header).toHaveClass('z-10');
    });
  });

  describe('welcome modal (#157)', () => {
    it('shows WelcomeModal when settings.general.welcomeSeen is false', async () => {
      mockCounts(0);
      mockAuth();
      vi.mocked(api.getSettings).mockResolvedValue(
        createMockSettings({ general: { welcomeSeen: false } }),
      );

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(screen.getByText('Welcome to narratorr')).toBeInTheDocument();
    });

    it('does not show WelcomeModal when settings.general.welcomeSeen is true', async () => {
      mockCounts(0);
      mockAuth();
      vi.mocked(api.getSettings).mockResolvedValue(
        createMockSettings({ general: { welcomeSeen: true } }),
      );

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByText('narratorr')).toBeInTheDocument();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not show WelcomeModal while settings query is still loading', () => {
      mockCounts(0);
      mockAuth();
      vi.mocked(api.getSettings).mockReturnValue(new Promise(() => {})); // never resolves

      renderWithProviders(<Layout />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('onDismiss calls updateSettings({ general: { welcomeSeen: true } })', async () => {
      const user = userEvent.setup();
      mockCounts(0);
      mockAuth();
      vi.mocked(api.getSettings).mockResolvedValue(
        createMockSettings({ general: { welcomeSeen: false } }),
      );
      vi.mocked(api.updateSettings).mockResolvedValue(
        createMockSettings({ general: { welcomeSeen: true } }),
      );

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(vi.mocked(api.updateSettings)).toHaveBeenCalledWith({
          general: { welcomeSeen: true },
        });
      });
    });

    it('modal disappears after successful dismiss', async () => {
      const user = userEvent.setup();
      mockCounts(0);
      mockAuth();
      vi.mocked(api.getSettings)
        .mockResolvedValueOnce(createMockSettings({ general: { welcomeSeen: false } }))
        .mockResolvedValue(createMockSettings({ general: { welcomeSeen: true } }));
      vi.mocked(api.updateSettings).mockResolvedValue(
        createMockSettings({ general: { welcomeSeen: true } }),
      );

      renderWithProviders(<Layout />);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });
  });
});
