import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { SearchSettingsPage } from './SearchSettingsPage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

const mockSettings = createMockSettings({
  search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
  rss: { enabled: false, intervalMinutes: 30 },
  quality: {
    protocolPreference: 'none',
    grabFloor: 50,
    minSeeders: 3,
    rejectWords: 'German',
    requiredWords: 'M4B',
    preferredLanguage: 'english',
  },
  metadata: { audibleRegion: 'us' },
});

describe('SearchSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders Search card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Search Interval (minutes)')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    expect(screen.getByLabelText('Blacklist TTL (days)')).toBeInTheDocument();
    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
    expect(screen.getByLabelText('RSS Interval (minutes)')).toBeInTheDocument();
  });

  it('renders Filtering card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Preferred Language')).toBeInTheDocument();
    expect(screen.getByLabelText('Reject Words')).toBeInTheDocument();
    expect(screen.getByLabelText('Required Words')).toBeInTheDocument();
  });

  it('renders Quality card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Seeders')).toBeInTheDocument();
  });

  it('renders three separate cards with independent forms', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Search')).toBeInTheDocument();
    });
    expect(screen.getByText('Filtering')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();

    // Each card has its own SettingsSection wrapper — check for 3 distinct section titles
    const forms = document.querySelectorAll('form');
    expect(forms).toHaveLength(3);
  });

  it('Region dropdown shows country names, not Audible format', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });

    const options = screen.getByLabelText('Region').querySelectorAll('option');
    const labels = Array.from(options).map((o) => o.textContent);
    expect(labels).toContain('United States');
    expect(labels).not.toContain('Audible.com (US)');
  });
});
