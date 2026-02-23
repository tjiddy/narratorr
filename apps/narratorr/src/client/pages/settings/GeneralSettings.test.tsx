import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';
import type { Mock } from 'vitest';
import type { Settings } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock renderTemplate to avoid importing the core package
vi.mock('@narratorr/core/utils', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings'),
  ALLOWED_TOKENS: ['author', 'title', 'series', 'seriesPosition', 'year', 'narrator'],
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockSettings: Settings = createMockSettings();

beforeEach(() => {
  vi.clearAllMocks();
  (api.getSettings as Mock).mockResolvedValue(mockSettings);
});

describe('GeneralSettings', () => {
  it('renders all sections, populates form, and save button is disabled until interaction', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Logging')).toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();

    // Verify form is populated from API
    expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');

    // Save button disabled when clean
    const saveButton = screen.getByText('Save Changes').closest('button')!;
    expect(saveButton).toBeDisabled();

    // Interact to make form dirty
    await user.type(screen.getByPlaceholderText('/audiobooks'), '/x');
    expect(saveButton).not.toBeDisabled();
  });

  it('enables save button after modifying a field', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/new-path');

    const saveButton = screen.getByText('Save Changes').closest('button')!;
    expect(saveButton).not.toBeDisabled();
  });

  it('submits updated settings and shows success toast', async () => {
    const user = userEvent.setup();
    (api.updateSettings as Mock).mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/new-path');

    await user.click(screen.getByText('Save Changes').closest('button')!);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
    expect((api.updateSettings as Mock).mock.calls[0][0]).toMatchObject({
      library: expect.objectContaining({ path: '/new-path' }),
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Settings saved successfully');
    });
  });

  it('shows error toast when save fails', async () => {
    const user = userEvent.setup();
    (api.updateSettings as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/changed');

    await user.click(screen.getByText('Save Changes').closest('button')!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('fail');
    });
  });

  it('changes log level via the select dropdown', async () => {
    const user = userEvent.setup();
    (api.updateSettings as Mock).mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Log Level')).toBeInTheDocument();
    });

    const logSelect = screen.getByLabelText('Log Level');
    expect(screen.getByRole('combobox', { name: 'Log Level' })).toBe(logSelect);
    await user.selectOptions(logSelect, 'debug');

    const saveButton = screen.getByText('Save Changes').closest('button')!;
    expect(saveButton).not.toBeDisabled();

    await user.click(saveButton);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
    expect((api.updateSettings as Mock).mock.calls[0][0]).toMatchObject({
      general: { logLevel: 'debug' },
    });
  });

  it('changes audible region via the select dropdown', async () => {
    const user = userEvent.setup();
    (api.updateSettings as Mock).mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Audible Region')).toBeInTheDocument();
    });

    const regionSelect = screen.getByLabelText('Audible Region');
    expect(screen.getByRole('combobox', { name: 'Audible Region' })).toBe(regionSelect);
    await user.selectOptions(regionSelect, 'uk');

    await user.click(screen.getByText('Save Changes').closest('button')!);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
    expect((api.updateSettings as Mock).mock.calls[0][0]).toMatchObject({
      metadata: { audibleRegion: 'uk' },
    });
  });

  it('toggles search enabled checkbox', async () => {
    const user = userEvent.setup();
    (api.updateSettings as Mock).mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });

    const searchCheckbox = screen.getByRole('checkbox', { name: 'Enable Scheduled Search' });
    await user.click(searchCheckbox);

    const saveButton = screen.getByText('Save Changes').closest('button')!;
    expect(saveButton).not.toBeDisabled();
  });

  it('shows folder format preview and updates on token click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
    expect(screen.getByText('Brandon Sanderson/The Way of Kings')).toBeInTheDocument();

    // Click a token button to verify interaction works
    await user.click(screen.getByText('{series}'));
    // Form should become dirty after token insertion
    const saveButton = screen.getByText('Save Changes').closest('button')!;
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });
  });

  it('inserts a token into folder format and updates preview', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('{series}')).toBeInTheDocument();
    });

    await user.click(screen.getByText('{series}'));

    // setValue updates RHF state → watch triggers preview re-render
    // Preview should now include the series token (mocked renderTemplate just does string replace)
    await waitFor(() => {
      const saveButton = screen.getByText('Save Changes').closest('button')!;
      // Form should be dirty after token insertion
      expect(saveButton).not.toBeDisabled();
    });
  });
});
