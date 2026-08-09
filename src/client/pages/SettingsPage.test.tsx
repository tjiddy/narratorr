import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsLayout } from '@/pages/settings';

// Full SettingsLayout renders can exhaust RTL's 1s poll budget under suite load; raise both ceilings so waitFor cannot outlive the test.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20000 });

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

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { createMockSettings, createMockIndexer, createMockDownloadClient } from '@/__tests__/factories';

const mockSettings = createMockSettings({
  search: { enabled: true, intervalMinutes: 30, blacklistTtlDays: 7 },
  import: { deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 5 },
  // Distinct from defaults so settingsHydrated can observe RHF's deferred reset in the DOM.
  library: { path: '/audiobooks-hydrated' },
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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="settings/*" element={<SettingsLayout />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

// Cache success precedes RHF's deferred reset; the distinct library path proves hydration reached the DOM.
async function settingsHydrated(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(['settings'])?.status).toBe('success');
  });
  await waitFor(() => {
    expect((screen.getByPlaceholderText('/audiobooks') as HTMLInputElement).value).toBe('/audiobooks-hydrated');
  });
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

    await user.type(screen.getByPlaceholderText('Newznab'), 'My Indexer');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'newznab.example.com');
    await user.type(screen.getByLabelText('API Key'), 'test-key');

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testIndexerConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Indexer',
          type: 'newznab',
          settings: expect.objectContaining({ apiUrl: 'newznab.example.com' }),
        }),
      );
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

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

    await user.type(screen.getByPlaceholderText('Newznab'), 'My Indexer');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'bad-host');
    await user.type(screen.getByLabelText('API Key'), 'test-key');

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testIndexerConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Indexer',
          type: 'newznab',
          settings: expect.objectContaining({ apiUrl: 'bad-host' }),
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

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
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

    // The text input precedes the type select with the same value.
    const nameInput = screen.getAllByDisplayValue('AudioBookBay')[0];
    await user.clear(nameInput!);
    await user.type(nameInput!, 'Updated');

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

    // The text input precedes the type select with the same value.
    const nameInput = screen.getAllByDisplayValue('qBittorrent')[0];
    await user.clear(nameInput!);
    await user.type(nameInput!, 'Updated');

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
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
    expect(screen.getByLabelText('File token reference')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Folder token reference'));
    expect(screen.getAllByText('{author}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{title}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{series}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{year}').length).toBeGreaterThanOrEqual(1);
  });

  it('shows live preview with sample data rendered through real renderTemplate/renderFilename', async () => {
    renderSettingsPage('/settings');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });

    const folderPreviews = await screen.findAllByTestId('preview-with-series');
    const folderTexts = folderPreviews.map((el) => el.textContent);
    expect(folderTexts).toEqual(expect.arrayContaining([
      expect.stringContaining('Brandon Sanderson/The Way of Kings'),
      expect.stringContaining('Brandon Sanderson - The Way of Kings'),
    ]));

    const noSeriesPreviews = await screen.findAllByTestId('preview-without-series');
    const noSeriesTexts = noSeriesPreviews.map((el) => el.textContent);
    expect(noSeriesTexts).toEqual(expect.arrayContaining([
      expect.stringContaining('Andy Weir/Project Hail Mary'),
      expect.stringContaining('Andy Weir - Project Hail Mary'),
    ]));
  });

  it('clicking a token chip inserts it into the input', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Folder token reference'));
    await user.click(screen.getAllByText('{year}')[0]!);

    const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    expect(input.value).toContain('{year}');
  });
});

describe('SettingsPage - {edition} auto-behavior preview (#1774, real @core/utils)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('auto-suffix branch: the Multiple editions row = With-series folder leaf + " (Full Cast)"', async () => {
    renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    // Must match buildTargetPath's sanitized suffix composition byte-for-byte.
    const row = await screen.findByTestId('preview-multi-edition');
    expect(row.textContent).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
  });

  it('in-place branch: {edition} renders at its position with no double suffix; baseline row stays edition-free', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    const folderInput = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    fireEvent.change(folderInput, { target: { value: '{author}/{title}/{edition}' } });

    await waitFor(() => {
      expect(screen.getByTestId('preview-multi-edition').textContent).toBe('Brandon Sanderson/The Way of Kings/Full Cast');
    });
    expect(screen.getByTestId('preview-multi-edition').textContent).not.toContain('(Full Cast)');
    // Both baseline fixtures omit edition; pin both so fixture drift cannot mask this branch.
    expect(screen.getAllByTestId('preview-with-series')[0]!.textContent).not.toContain('Full Cast');
    expect(screen.getAllByTestId('preview-without-series')[0]!.textContent).not.toContain('Full Cast');
  });

  it('baseline file rows stay edition-free even when the file format places {edition}', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    const fileInput = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { value: '{author} - {title} ({edition})' } });

    await waitFor(() => {
      expect((screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement).value).toBe('{author} - {title} ({edition})');
    });
    // With/Without-series file previews are index 1; multi-file is file-only.
    expect(screen.getAllByTestId('preview-with-series')[1]!.textContent).not.toContain('Full Cast');
    expect(screen.getAllByTestId('preview-without-series')[1]!.textContent).not.toContain('Full Cast');
    expect(screen.getByTestId('preview-multi-file').textContent).not.toContain('Full Cast');
  });

  it('row shape: one Multiple-editions row (folder), one Multi-file row (file), one folder-only note', async () => {
    renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('preview-multi-edition')).toHaveLength(1);
    expect(screen.getAllByTestId('preview-multi-file')).toHaveLength(1);
    expect(screen.getAllByText(/kept side-by-side automatically/)).toHaveLength(1);
  });
});

describe('SettingsPage - {edition} file preview row (#1819, real @core/utils)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);
    vi.mocked(api.getIndexers).mockResolvedValue([]);
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it('conditional {edition} form renders the full sample filename including the .m4b suffix (AC1)', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    // Section-test mocks cannot exercise conditional wrappers; this pins the real renderFilename output.
    const fileInput = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { value: '{author} - {series? - }{seriesPosition:00? - }{title}{ (?edition?)}' } });
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toBe(
        'Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast).m4b',
      );
    });
  });

  // A controlled deferred pins typing before hydration; a fixed delay can shift both events together.
  it('a keystroke made before the settings query resolves survives hydration (#2033)', async () => {
    let resolveSettings!: (v: typeof mockSettings) => void;
    vi.mocked(api.getSettings).mockImplementation(
      () => new Promise((resolve) => { resolveSettings = resolve; }),
    );
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toMatch(/Add \{edition\}/);
    });
    const fileInput = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { value: '{title}{ (?edition?)}' } });
    resolveSettings(mockSettings);
    // The broken reset lands one act cycle after cache success; wait for DOM-observable hydration before asserting.
    await settingsHydrated(queryClient);
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toBe('The Way of Kings (Full Cast).m4b');
      expect(fileInput.value).toBe('{title}{ (?edition?)}');
    });
    // A second settled read catches a reset lagging one cycle.
    await waitFor(() => {
      expect(fileInput.value).toBe('{title}{ (?edition?)}');
      expect(screen.getByTestId('preview-file-edition').textContent).toBe('The Way of Kings (Full Cast).m4b');
    });
  });

  it('row live-updates as the file format is edited (real renderer)', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    const fileInput = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toMatch(/Add \{edition\}/);
    });
    fireEvent.change(fileInput, { target: { value: '{title}{ (?edition?)}' } });
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toBe('The Way of Kings (Full Cast).m4b');
    });
    fireEvent.change(fileInput, { target: { value: '{author} - {title}{ (?edition?)}' } });
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toBe('Brandon Sanderson - The Way of Kings (Full Cast).m4b');
    });
  });

  it('no {edition} token: file edition row shows the capability affordance, not a With-series duplicate (AC2)', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    const row = await screen.findByTestId('preview-file-edition');
    expect(row.textContent).toMatch(/Add \{edition\} to include the edition label in filenames/);
    // The with-series file preview is index 1.
    const withSeriesFile = screen.getAllByTestId('preview-with-series')[1]!;
    expect(row.textContent).not.toBe(withSeriesFile.textContent);
  });

  it('row shape: exactly one file edition row (file) and one multiple-editions row (folder)', async () => {
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    expect(screen.getAllByTestId('preview-file-edition')).toHaveLength(1);
    expect(screen.getAllByTestId('preview-multi-edition')).toHaveLength(1);
  });

  it('selecting the Detailed preset flips the file edition row from the hint to a rendered filename (#1829)', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderSettingsPage('/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'File Naming' })).toBeInTheDocument();
    });
    await settingsHydrated(queryClient);
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toMatch(/Add \{edition\}/);
    });
    await user.selectOptions(screen.getByLabelText('Preset'), 'detailed');
    await waitFor(() => {
      expect(screen.getByTestId('preview-file-edition').textContent).toBe(
        'Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast).m4b',
      );
    });
  });
});
