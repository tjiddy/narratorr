import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  SettingsLayout,
  GeneralSettings,
  IndexersSettings,
  DownloadClientsSettings,
} from '@/pages/settings';

vi.mock('@/components/library/BulkOperationsSection', () => ({
  BulkOperationsSection: () => null,
}));

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getIndexers: vi.fn(),
    createIndexer: vi.fn(),
    deleteIndexer: vi.fn(),
    updateIndexer: vi.fn(),
    testIndexer: vi.fn(),
    testIndexerConfig: vi.fn(),
    getClients: vi.fn(),
    createClient: vi.fn(),
    deleteClient: vi.fn(),
    updateClient: vi.fn(),
    testClient: vi.fn(),
    testClientConfig: vi.fn(),
  },
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FOLDER_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
  NAMING_PRESETS: [
    { id: 'standard', name: 'Standard', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    { id: 'audiobookshelf', name: 'Audiobookshelf', folderFormat: '{author}/{series/}{title}', fileFormat: '{title}' },
    { id: 'plex', name: 'Plex', folderFormat: '{author}/{series/}{year? - }{title}', fileFormat: '{title}{trackNumber:00? - pt}' },
    { id: 'last-first', name: 'Last, First', folderFormat: '{authorLastFirst}/{titleSort}', fileFormat: '{authorLastFirst} - {titleSort}' },
  ],
  detectPreset: (folder: string, file: string) => {
    if (folder === '{author}/{title}' && file === '{author} - {title}') return 'standard';
    return 'custom';
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { createMockSettings, createMockIndexer, createMockDownloadClient } from '@/__tests__/factories';

const mockSettings = createMockSettings({
  search: { enabled: true, intervalMinutes: 30, blacklistTtlDays: 7 },
  import: { deleteAfterImport: false, minSeedTime: 0, minFreeSpaceGB: 5 },
});

const mockIndexer = createMockIndexer({ id: 1, name: 'AudioBookBay' });

const mockClient = createMockDownloadClient({
  id: 1,
  name: 'qBittorrent',
  settings: { host: 'localhost', port: 8080, username: 'admin', password: 'secret', useSsl: false },
});

function renderSettingsPage(route = '/settings/indexers') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<GeneralSettings />} />
            <Route path="indexers" element={<IndexersSettings />} />
            <Route path="download-clients" element={<DownloadClientsSettings />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsPage - Indexer form test button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('renders Test button in indexer create form', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Indexers' })).toBeInTheDocument();
    });

    // Open the form
    await user.click(screen.getByText('Add Indexer'));

    await waitFor(() => {
      expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    });

    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('calls testIndexerConfig on Test button click with form values', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testIndexerConfig).mockResolvedValue({ success: true });

    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Indexers' })).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer'));

    await waitFor(() => {
      expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    });

    // Fill in form
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'My Indexer');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'abb.example.com');

    // Click Test
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testIndexerConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Indexer',
          type: 'abb',
          settings: expect.objectContaining({ hostname: 'abb.example.com' }),
        }),
      );
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

    // Check inline result
    expect(screen.getByText('Connection successful!')).toBeInTheDocument();
  });

  it('shows error result on failed test', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testIndexerConfig).mockResolvedValue({ success: false, message: 'Connection refused' });

    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Indexers' })).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer'));

    await waitFor(() => {
      expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'My Indexer');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'bad-host');

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testIndexerConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Indexer',
          type: 'abb',
          settings: expect.objectContaining({ hostname: 'bad-host' }),
        }),
      );
      expect(toast.error).toHaveBeenCalledWith('Connection refused');
    });

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('validates form before testing', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Indexers' })).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer'));

    await waitFor(() => {
      expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    });

    // Click Test without filling in name (required)
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      // Form validation should prevent API call
      expect(api.testIndexerConfig).not.toHaveBeenCalled();
    });
  });
});

describe('SettingsPage - Download client form test button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('renders Test button in download client create form', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Download Clients' })).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Client'));

    await waitFor(() => {
      expect(screen.getByText('Add Download Client')).toBeInTheDocument();
    });

    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('calls testClientConfig on Test button click', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testClientConfig).mockResolvedValue({ success: true });

    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Download Clients' })).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Client'));

    await waitFor(() => {
      expect(screen.getByText('Add Download Client')).toBeInTheDocument();
    });

    // Fill in required fields
    await user.type(screen.getByPlaceholderText('qBittorrent'), 'My Client');
    await user.type(screen.getByPlaceholderText('localhost'), '192.168.1.100');

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testClientConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Client',
          type: 'qbittorrent',
          settings: expect.objectContaining({ host: '192.168.1.100' }),
        }),
      );
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

    expect(screen.getByText('Connection successful!')).toBeInTheDocument();
  });
});

describe('SettingsPage - Edit indexer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([mockIndexer]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('renders Edit button on each indexer card', async () => {
    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
    });

    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('opens pre-populated edit form when Edit is clicked', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    });

    // Check form is pre-populated (name input + type select both show 'AudioBookBay')
    expect(screen.getAllByDisplayValue('AudioBookBay').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue('audiobookbay.lu')).toBeInTheDocument();
  });

  it('calls updateIndexer on save', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateIndexer).mockResolvedValue({ ...mockIndexer, name: 'Updated' });

    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    });

    // Change name (first match is the text input, second is the type select)
    const nameInput = screen.getAllByDisplayValue('AudioBookBay')[0];
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated');

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateIndexer).toHaveBeenCalledWith(1, expect.objectContaining({
        name: 'Updated',
      }));
      expect(toast.success).toHaveBeenCalledWith('Indexer updated');
    });
  });

  it('collapses form on Cancel', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/indexers');

    await waitFor(() => {
      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Edit Indexer')).not.toBeInTheDocument();
    });

    // Card should still be visible
    expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
  });
});

describe('SettingsPage - Edit download client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([mockClient]);
  });

  it('renders Edit button on each download client card', async () => {
    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByText('qBittorrent')).toBeInTheDocument();
    });

    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('opens pre-populated edit form when Edit is clicked', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByText('qBittorrent')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Download Client')).toBeInTheDocument();
    });

    // Name input + type select both show 'qBittorrent'
    expect(screen.getAllByDisplayValue('qBittorrent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue('localhost')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8080')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin')).toBeInTheDocument();
  });

  it('calls updateClient on save', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateClient).mockResolvedValue({ ...mockClient, name: 'Updated' });

    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByText('qBittorrent')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Download Client')).toBeInTheDocument();
    });

    // First match is the text input, second is the type select
    const nameInput = screen.getAllByDisplayValue('qBittorrent')[0];
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated');

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateClient).toHaveBeenCalledWith(1, expect.objectContaining({
        name: 'Updated',
      }));
      expect(toast.success).toHaveBeenCalledWith('Download client updated');
    });
  });

  it('collapses form on Cancel', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByText('qBittorrent')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Download Client')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Edit Download Client')).not.toBeInTheDocument();
    });

    expect(screen.getByText('qBittorrent')).toBeInTheDocument();
  });

  it('masks password field in edit form', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/download-clients');

    await waitFor(() => {
      expect(screen.getByText('qBittorrent')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByText('Edit Download Client')).toBeInTheDocument();
    });

    const passwordInput = screen.getByDisplayValue('secret');
    expect(passwordInput).toHaveAttribute('type', 'password');
  });
});

describe('SettingsPage - Folder format token chips and preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('renders token panels that expand to show all allowed tokens', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
    });

    // Token reference buttons visible
    expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
    expect(screen.getByLabelText('File token reference')).toBeInTheDocument();

    // Open both token reference modals and check tokens
    await user.click(screen.getByLabelText('Folder token reference'));
    expect(screen.getAllByText('{author}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{title}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{series}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{year}').length).toBeGreaterThanOrEqual(1);
  });

  it('shows live preview with sample data', async () => {
    renderSettingsPage('/settings');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
    });

    // Preview shows both with-series and without-series examples
    await waitFor(() => {
      expect(screen.getByText('With series')).toBeInTheDocument();
      expect(screen.getByText('Without series')).toBeInTheDocument();
    });
  });

  it('clicking a token chip inserts it into the input', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
    });

    // Open folder format token reference modal, then click {year}
    await user.click(screen.getByLabelText('Folder token reference'));
    await user.click(screen.getAllByText('{year}')[0]);

    // The folder format input should now contain {year}
    const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    expect(input.value).toContain('{year}');
  });
});
