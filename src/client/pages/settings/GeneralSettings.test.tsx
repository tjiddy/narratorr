import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testProxy: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings());
});

describe('GeneralSettings', () => {
  it('renders all settings sections', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('Post Processing')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Housekeeping')).toBeInTheDocument();
    expect(screen.getByText('Logging')).toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();
  });

  it('save buttons are hidden when all sections are clean', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    // No save buttons visible when no sections are dirty
    expect(screen.queryAllByRole('button', { name: /save/i })).toHaveLength(0);
  });

  it('does not render a single global save button', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
  });

  it('preserves dirty state in one section when another section saves', async () => {
    const settings = createMockSettings();
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);

    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    // Wait for sections to load
    await waitFor(() => {
      expect(screen.getByLabelText('Event History Retention (days)')).toBeInTheDocument();
    });

    // Make General section dirty by changing retention days
    const retentionInput = screen.getByLabelText('Event History Retention (days)');
    await user.clear(retentionInput);
    await user.type(retentionInput, '42');

    // Also make Network section dirty with a valid proxy URL
    const proxyInput = screen.getByLabelText('Proxy URL');
    await user.type(proxyInput, 'http://proxy:8080');

    // Both sections should show their save buttons
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);

    // Save the Network section — click its save button and submit
    const networkForm = proxyInput.closest('form')!;
    fireEvent.submit(networkForm);

    // Wait for Network save to complete (updateSettings called)
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalled();
    });

    // After Network save + cache invalidation refetch, General section should
    // still have its dirty value preserved (the !isDirty guard prevents reset)
    expect(retentionInput).toHaveValue(42);

    // General section save button should still be visible (still dirty)
    const remainingSaveButtons = screen.getAllByRole('button', { name: /^save$/i });
    expect(remainingSaveButtons.length).toBeGreaterThanOrEqual(1);
  });
});
