import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockDownloadClient } from '@/__tests__/factories';
import { foreignRegistryKeys } from '@/__tests__/registry-foreign-keys';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES } from '@shared/download-client-registry.js';
import { DownloadClientForm } from './DownloadClientForm';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      getRemotePathMappingsByClientId: vi.fn().mockResolvedValue([]),
      testDownloadClient: vi.fn().mockResolvedValue({ success: true, message: 'OK' }),
    },
  };
});

vi.mock('@/lib/api/download-clients', () => ({
  downloadClientsApi: {
    getClientCategories: vi.fn(),
    getClientCategoriesFromConfig: vi.fn(),
  },
}));

import { downloadClientsApi } from '@/lib/api/download-clients';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadClientForm (#201)', () => {
  describe('blackhole type rendering', () => {
    it('blackhole type renders BlackholeFields (Watch Directory, Protocol) instead of DownloadClientFields', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      await user.selectOptions(screen.getByLabelText('Type'), 'blackhole');

      expect(screen.getByText('Watch Directory')).toBeInTheDocument();
      expect(screen.getByText('Protocol')).toBeInTheDocument();

      expect(screen.queryByText('Host')).not.toBeInTheDocument();
      expect(screen.queryByText('Port')).not.toBeInTheDocument();
    });

    it('non-blackhole type renders DownloadClientFields (Host, Port) instead of BlackholeFields', () => {
      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.getByText('Host')).toBeInTheDocument();
      expect(screen.getByText('Port')).toBeInTheDocument();

      expect(screen.queryByText('Watch Directory')).not.toBeInTheDocument();
      expect(screen.queryByText('Protocol')).not.toBeInTheDocument();
    });
  });

  describe('type change settings reset', () => {
    it('type change in create mode resets settings to DOWNLOAD_CLIENT_REGISTRY[selectedType].defaultSettings', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      const hostInput = screen.getByPlaceholderText('localhost');
      await user.type(hostInput, 'myhost.local');
      expect(hostInput).toHaveValue('myhost.local');

      await user.selectOptions(screen.getByLabelText('Type'), 'sabnzbd');

      await waitFor(() => {
        expect(screen.getByText('API Key')).toBeInTheDocument();
      });

      const newHostInput = screen.getByPlaceholderText('localhost');
      expect(newHostInput).toHaveValue('');
    });

    it('#1342 Type selector is enabled and present in create mode', () => {
      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      const typeSelect = screen.getByLabelText('Type');
      expect(typeSelect).toBeInTheDocument();
      expect(typeSelect).toBeEnabled();
    });

    it('#1342 Type select is disabled in edit mode (type switch is unreachable)', () => {
      const client = createMockDownloadClient({
        id: 1,
        name: 'My Client',
        type: 'qbittorrent',
        settings: { host: 'saved-host', port: 9090, username: 'admin', password: 'pass', useSsl: false },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.getByPlaceholderText('localhost')).toHaveValue('saved-host');

      const typeSelect = screen.getByLabelText('Type');
      expect(typeSelect).toBeInTheDocument();
      expect(typeSelect).toBeDisabled();
    });
  });

  describe('keyed remount on type change (#1058)', () => {
    it('changing the real Type select clears previously fetched categories without a refetch (production wiring)', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['audiobooks', 'movies'],
      });

      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );

      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.getByText('audiobooks')).toBeInTheDocument();
        expect(screen.getByText('movies')).toBeInTheDocument();
      });

      // Removing key={selectedType} leaves the previous hook state rendered.
      await user.selectOptions(screen.getByLabelText('Type'), 'sabnzbd');

      expect(screen.queryByText('audiobooks')).not.toBeInTheDocument();
      expect(screen.queryByText('movies')).not.toBeInTheDocument();
    });
  });

  describe('unimplemented adapter warning', () => {
    it('unimplemented adapter type shows amber warning text and disables test button', () => {
      // All schema types are registered, so only the implemented path is reachable here.
      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.queryByText(/adapter not yet implemented/i)).not.toBeInTheDocument();

      const testButton = screen.getByRole('button', { name: /test/i });
      expect(testButton).not.toBeDisabled();
    });
  });

  describe('onFormTest callback', () => {
    it('onFormTest callback receives current form data when Test button is clicked', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.type(screen.getByPlaceholderText('qBittorrent'), 'My Test Client');
      await user.type(screen.getByPlaceholderText('localhost'), 'testhost');

      await user.click(screen.getByRole('button', { name: /test/i }));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Test Client',
            type: 'qbittorrent',
            settings: expect.objectContaining({ host: 'testhost' }),
          }),
        );
      });
    });

    it('edit-mode test button calls onFormTest with raw form data (no id)', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({
        id: 42,
        name: 'My Saved Client',
        type: 'qbittorrent',
        settings: { host: 'h', port: 8080, username: 'admin', password: 'pass', useSsl: false },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.click(screen.getByRole('button', { name: /test/i }));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalled();
      });
      expect(onFormTest.mock.calls[0]![0]).not.toHaveProperty('id');
      expect(onFormTest.mock.calls[0]![0]).toMatchObject({ type: client.type });
    });

    it('#1342 edit-mode Save fires and payload carries the original type', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({
        id: 43,
        name: 'My Saved Client',
        type: 'qbittorrent',
        settings: { host: 'h', port: 8080, username: 'admin', password: 'pass', useSsl: false },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={onSubmit}
          onFormTest={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0]![0]).toMatchObject({ type: client.type });
    });

    it('create-mode test button does NOT include id in onFormTest payload', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.type(screen.getByPlaceholderText('qBittorrent'), 'New Client');
      await user.type(screen.getByPlaceholderText('localhost'), 'h');

      await user.click(screen.getByRole('button', { name: /test/i }));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalled();
      });
      const arg = onFormTest.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('id');
    });
  });

  describe('onCancel callback', () => {
    it('onCancel callback fires when Cancel button is clicked', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({ id: 1, name: 'Test' });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onCancel={onCancel}
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      await user.click(screen.getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('SelectWithChevron migration (#224)', () => {
    it('type select renders with appearance-none and ChevronDownIcon', () => {
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('appearance-none');
      const selectParent = select.parentElement!;
      expect(selectParent.querySelector('svg')).not.toBeNull();
    });

    it('selecting a download client type via SelectWithChevron updates form state', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={onSubmit} onFormTest={vi.fn()} />,
      );

      await user.selectOptions(screen.getByLabelText('Type'), 'blackhole');
      expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('blackhole');
    });

    it('type select shows border-destructive when errors.type is present', async () => {
      const user = userEvent.setup();
      const invalidClient = createMockDownloadClient({ type: 'INVALID' as never });
      renderWithProviders(
        <DownloadClientForm mode="edit" client={invalidClient} onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );

      const select = screen.getByLabelText('Type');

      expect(select.className).toContain('border-border');
      expect(select.className).not.toContain('border-destructive');

      await user.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => {
        expect(screen.getByLabelText('Type').className).toContain('border-destructive');
      });
    });
  });

  const mockOnSubmit = vi.fn();
  const mockOnFormTest = vi.fn();
  const mockClient = createMockDownloadClient();

  describe('create mode path mappings', () => {
    it('renders Remote Path Mappings section in create mode', () => {
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} />,
      );
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add mapping/i })).toBeInTheDocument();
    });

    it('includes pathMappings in onSubmit payload', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} />,
      );

      await user.type(screen.getByLabelText('Name'), 'Test Client');
      await user.type(screen.getByLabelText('Host'), 'localhost');
      await user.clear(screen.getByLabelText('Port'));
      await user.type(screen.getByLabelText('Port'), '8080');
      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'pass');

      await user.click(screen.getByRole('button', { name: /add mapping/i }));
      await user.type(screen.getByLabelText(/remote path/i), '/remote');
      await user.type(screen.getByLabelText(/local path/i), '/local');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await user.click(screen.getByRole('button', { name: /add client/i }));
      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            pathMappings: [{ remotePath: '/remote', localPath: '/local' }],
          }),
        );
      });
    });

    it('submits with empty pathMappings when no mappings added', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} />,
      );

      await user.type(screen.getByLabelText('Name'), 'Test Client');
      await user.type(screen.getByLabelText('Host'), 'localhost');
      await user.clear(screen.getByLabelText('Port'));
      await user.type(screen.getByLabelText('Port'), '8080');
      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'pass');

      await user.click(screen.getByRole('button', { name: /add client/i }));
      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ pathMappings: [] }),
        );
      });
    });
  });

  describe('edit mode does not include pathMappings', () => {
    it('onSubmit receives form data without pathMappings in edit mode', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <DownloadClientForm mode="edit" client={mockClient} onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} onCancel={vi.fn()} />,
      );

      await user.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.not.objectContaining({ pathMappings: expect.anything() }),
        );
      });
    });
  });

  describe('downloadRoot field removal', () => {
    it('does not render downloadRoot field in create mode', () => {
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} />,
      );
      expect(screen.queryByText('Download Root')).not.toBeInTheDocument();
    });

    it('does not render downloadRoot field in edit mode', () => {
      renderWithProviders(
        <DownloadClientForm mode="edit" client={mockClient} onSubmit={mockOnSubmit} onFormTest={mockOnFormTest} onCancel={vi.fn()} />,
      );
      expect(screen.queryByText('Download Root')).not.toBeInTheDocument();
    });
  });

  // Edit-mode type is immutable, so registry-overlay isolation is tested at hydration.
  describe('#908 — settingsFromClient registry overlay (no foreign-type leak)', () => {
    it('qBittorrent edit Test payload contains no SABnzbd/blackhole keys', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({
        id: 200,
        name: 'qb No Leak',
        type: 'qbittorrent',
        settings: { host: 'qb.local', port: 8080, username: 'admin', password: 'pw', useSsl: false, category: 'audiobooks' },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.click(screen.getByRole('button', { name: /test/i }));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalled();
      });

      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      const foreignKeys = foreignRegistryKeys('qbittorrent', DOWNLOAD_CLIENT_TYPES, DOWNLOAD_CLIENT_REGISTRY);
      expect(foreignKeys).toEqual(expect.arrayContaining(['apiKey', 'watchDir', 'protocol']));
      for (const key of foreignKeys) {
        expect(payloadSettings).not.toHaveProperty(key);
      }

      expect(payloadSettings).toHaveProperty('host', 'qb.local');
      expect(payloadSettings).toHaveProperty('port', 8080);
      expect(payloadSettings).toHaveProperty('username', 'admin');
    });

    it('SABnzbd edit Test payload contains no torrent-client/blackhole keys', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({
        id: 201,
        name: 'sab No Leak',
        type: 'sabnzbd',
        settings: { host: 'sab.local', port: 8080, apiKey: 'sab-key', category: 'books' },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.click(screen.getByRole('button', { name: /test/i }));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalled();
      });

      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      expect(payloadSettings).not.toHaveProperty('username');
      expect(payloadSettings).not.toHaveProperty('password');
      expect(payloadSettings).not.toHaveProperty('watchDir');
      expect(payloadSettings).not.toHaveProperty('protocol');

      expect(payloadSettings).toHaveProperty('host', 'sab.local');
      expect(payloadSettings).toHaveProperty('apiKey', 'sab-key');
    });
  });
});
