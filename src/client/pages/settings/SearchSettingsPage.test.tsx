import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  },
  metadata: { audibleRegion: 'us', languages: ['english'] },
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
    expect(screen.getByText('Languages')).toBeInTheDocument();
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

  it('saving one card preserves dirty state in another card after shared query refetch', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsPage />);

    // Wait for all cards to load
    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    // Dirty the Quality card by changing grabFloor
    const grabFloorInput = screen.getByLabelText('MB/hr Grab Minimum');
    await user.tripleClick(grabFloorInput);
    await user.keyboard('100');

    // The Quality card's Save button should be visible
    const qualityForm = grabFloorInput.closest('form')!;
    expect(qualityForm.querySelector('button[type="submit"]')).toBeInTheDocument();

    // Now dirty the Filtering card by changing reject words
    const rejectInput = screen.getByLabelText('Reject Words');
    await user.tripleClick(rejectInput);
    await user.keyboard('Abridged');

    // Save the Filtering card (not the Quality card)
    const filteringForm = rejectInput.closest('form')!;
    fireEvent.submit(filteringForm);

    // Wait for Filtering save to complete (triggers queryClient.invalidateQueries)
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalled();
    });

    // Quality card should still have the dirty edited value (not reset to server value)
    expect(grabFloorInput).toHaveValue(100);

    // Quality card's Save button should still be visible (still dirty)
    expect(qualityForm.querySelector('button[type="submit"]')).toBeInTheDocument();
  });
});
