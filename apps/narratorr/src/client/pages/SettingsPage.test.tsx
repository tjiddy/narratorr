import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from '@/pages/SettingsPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getIndexers: vi.fn(),
    createIndexer: vi.fn(),
    deleteIndexer: vi.fn(),
    testIndexer: vi.fn(),
    testIndexerConfig: vi.fn(),
    getClients: vi.fn(),
    createClient: vi.fn(),
    deleteClient: vi.fn(),
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

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockSettings = {
  library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
  search: { intervalMinutes: 30, enabled: true },
  import: { deleteAfterImport: false, minSeedTime: 0 },
  general: { logLevel: 'info' as const },
};

function renderSettingsPage(route = '/settings/indexers') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="settings/*" element={<SettingsPage />} />
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
      expect(api.testIndexerConfig).toHaveBeenCalled();
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
      expect(api.testIndexerConfig).toHaveBeenCalled();
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
      expect(api.testClientConfig).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

    expect(screen.getByText('Connection successful!')).toBeInTheDocument();
  });
});
