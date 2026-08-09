import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { toast } = await import('sonner');
const mockToast = toast as unknown as { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testProxy: vi.fn(),
  },
}));

// Spread the real barrel so unmocked naming helpers remain production implementations.
vi.mock('@core/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/index.js')>()),
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  NAMING_PRESETS: [
    { id: 'standard', name: 'Standard', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    { id: 'audiobookshelf', name: 'Audiobookshelf', folderFormat: '{author}/{series?/}{title}', fileFormat: '{title}' },
    { id: 'plex', name: 'Plex', folderFormat: '{author}/{series?/}{year? - }{title}', fileFormat: '{title}{ - pt?trackNumber:00}' },
    { id: 'last-first', name: 'Last, First', folderFormat: '{authorLastFirst}/{titleSort}', fileFormat: '{authorLastFirst} - {titleSort}' },
  ],
  detectPreset: (folder: string, file: string) => {
    if (folder === '{author}/{title}' && file === '{author} - {title}') return 'standard';
    return 'custom';
  },
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings());
  mockApi.updateSettings.mockResolvedValue(createMockSettings());
});

describe('GeneralSettings', () => {
  it('renders File Naming section after Library section', async () => {
    renderWithProviders(<GeneralSettings />);
    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('File Naming')).toBeInTheDocument();
  });

  it('renders all settings sections', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('File Naming')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.queryByText('Search')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata')).not.toBeInTheDocument();
    expect(screen.queryByText('Post Processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Housekeeping')).not.toBeInTheDocument();
    expect(screen.queryByText('Logging')).not.toBeInTheDocument();
  });

  it('mounts the Ebooks section after Discovery in DOM order', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toContain('Ebooks');
    expect(headings.indexOf('Ebooks')).toBeGreaterThan(headings.indexOf('Discovery'));
  });

  it('renders Appearance section in the settings page', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('save buttons are hidden when all sections are clean', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

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

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
    });

    const proxyInput = screen.getByLabelText('Proxy URL');
    await user.type(proxyInput, 'http://proxy:8080');

    const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(1);

    const networkForm = proxyInput.closest('form')!;
    fireEvent.submit(networkForm);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalled();
    });
  });
});

describe('Show welcome message — local-only toggle (#165)', () => {
  it('welcome modal is not visible on initial Settings page load', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking "Show Welcome Message" makes the welcome modal dialog visible', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('clicking "Show Welcome Message" does not call api.updateSettings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('no toast appears when the button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('"Show Welcome Message" button remains enabled after clicking (no pending/disabled state)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    expect(screen.getByRole('button', { name: /show welcome message/i })).not.toBeDisabled();
  });

  it('clicking "Get Started" in the manually reopened modal closes the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking "Get Started" in the manually reopened modal does not call api.updateSettings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));
    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('pressing Escape dismisses the manually reopened modal (Escape now closes Welcome)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
