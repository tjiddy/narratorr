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
    testHardcoverApiKey: vi.fn(),
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
      expect(screen.getByLabelText('Scheduled search')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Search interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol preference')).toBeInTheDocument();
    expect(screen.getByLabelText('Blacklist TTL')).toBeInTheDocument();
    expect(screen.getByLabelText('RSS sync')).toBeInTheDocument();
    expect(screen.getByLabelText('RSS interval')).toBeInTheDocument();
  });

  it('renders the New Book Defaults card (moved here from General settings)', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('When a New Book Is Added')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Search immediately')).toBeInTheDocument();
  });

  it('renders Filtering card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Reject words')).toBeInTheDocument();
    expect(screen.getByLabelText('Required words')).toBeInTheDocument();
  });

  it('renders Metadata card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Metadata')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
    expect(screen.getByLabelText('Hardcover API key')).toBeInTheDocument();
  });

  it('renders Quality card with all expected fields', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum seeders')).toBeInTheDocument();
  });

  it('renders five separate cards with independent forms', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Search')).toBeInTheDocument();
    });
    expect(screen.getByText('When a New Book Is Added')).toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();
    expect(screen.getByText('Filtering')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();

    const forms = document.querySelectorAll('form');
    expect(forms).toHaveLength(5);
  });

  it('Metadata card appears before Filtering card in document order', async () => {
    renderWithProviders(<SearchSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Metadata')).toBeInTheDocument();
    });

    const metadataHeading = screen.getByText('Metadata');
    const filteringHeading = screen.getByText('Filtering');
    expect(
      metadataHeading.compareDocumentPosition(filteringHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });

    const grabFloorInput = screen.getByLabelText('Grab minimum');
    await user.tripleClick(grabFloorInput);
    await user.keyboard('100');

    const qualityForm = grabFloorInput.closest('form')!;
    expect(qualityForm.querySelector('button[type="submit"]')).toBeInTheDocument();

    const rejectInput = screen.getByLabelText('Reject words');
    await user.tripleClick(rejectInput);
    await user.keyboard('Abridged');

    const filteringForm = rejectInput.closest('form')!;
    fireEvent.submit(filteringForm);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalled();
    });

    expect(grabFloorInput).toHaveValue(100);

    expect(qualityForm.querySelector('button[type="submit"]')).toBeInTheDocument();
  });

  describe('when the shared settings read fails', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks: clearAllMocks does not drain `*Once()` queues.
      vi.resetAllMocks();
    });

    it('gives each of its five cards its own addressable error copy', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<SearchSettingsPage />);

      await waitFor(() => expect(screen.getByText('Failed to load search settings.')).toBeInTheDocument());
      // One shared query fails all five at once, so getByText — which throws on a duplicate —
      // is the collision guard: identical copy on any two of them would fail here.
      expect(screen.getByText('Failed to load new book defaults.')).toBeInTheDocument();
      expect(screen.getByText('Failed to load metadata settings.')).toBeInTheDocument();
      expect(screen.getByText('Failed to load filtering settings.')).toBeInTheDocument();
      expect(screen.getByText('Failed to load quality settings.')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^Retry loading/ })).toHaveLength(5);
    });

    it("recovers all five cards from one card's Retry — they share the settings query", async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(mockSettings);
      const user = userEvent.setup();

      renderWithProviders(<SearchSettingsPage />);
      await waitFor(() => expect(screen.getByText('Failed to load quality settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading quality settings' }));

      await waitFor(() => expect(screen.getByLabelText('Grab minimum')).toHaveValue(50));
      expect(screen.queryByText(/^Failed to load/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
      expect(screen.getByLabelText('Minimum duration')).toBeInTheDocument();
    });
  });

});
