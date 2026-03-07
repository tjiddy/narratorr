import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockDownloadClient } from '@/__tests__/factories';
import {
  waitForListLoad,
  assertDeleteFlow,
  assertCancelDelete,
  assertDeleteError,
  assertToggleAddForm,
  assertSuccessToast,
  assertErrorToast,
} from '@/__tests__/crud-settings-helpers';
import { DownloadClientsSettings } from './DownloadClientsSettings';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getClients: vi.fn(),
    createClient: vi.fn(),
    updateClient: vi.fn(),
    deleteClient: vi.fn(),
    testClient: vi.fn(),
    testClientConfig: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';

const mockClients = [
  createMockDownloadClient({ id: 1 }),
  createMockDownloadClient({
    id: 2,
    name: 'My SABnzbd',
    type: 'sabnzbd',
    enabled: false,
    priority: 30,
    settings: { host: '192.168.1.10', port: 8085, apiKey: 'abc123', useSsl: true },
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.getClients as Mock).mockResolvedValue(mockClients);
});

describe('DownloadClientsSettings', () => {
  it('renders header and client list', async () => {
    renderWithProviders(<DownloadClientsSettings />);

    expect(screen.getByText('Download Clients')).toBeInTheDocument();
    await waitForListLoad('My qBittorrent');
    expect(screen.getByText('My SABnzbd')).toBeInTheDocument();
  });

  it('shows empty state when no clients exist', async () => {
    (api.getClients as Mock).mockResolvedValue([]);
    renderWithProviders(<DownloadClientsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No download clients configured')).toBeInTheDocument();
    });
  });

  it('toggles add form when Add Client button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await assertToggleAddForm(user, 'Add Client', 'Add Download Client');
  });

  it('creates a new download client', async () => {
    const user = userEvent.setup();
    (api.createClient as Mock).mockResolvedValue({ id: 3, name: 'New Client', type: 'qbittorrent', enabled: true, priority: 50, settings: {}, createdAt: '2024-01-01T00:00:00Z' });
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByText('Add Client').closest('button')!);
    await user.type(screen.getByPlaceholderText('qBittorrent'), 'New Client');
    await user.type(screen.getByPlaceholderText('localhost'), '192.168.1.5');
    await user.click(screen.getByRole('button', { name: /Add Client/i }));

    await waitFor(() => {
      expect(api.createClient).toHaveBeenCalled();
    });
    expect((api.createClient as Mock).mock.calls[0][0]).toMatchObject({
      name: 'New Client',
      settings: expect.objectContaining({ host: '192.168.1.5' }),
    });

    await assertSuccessToast('Download client added successfully');
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createClient as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByText('Add Client').closest('button')!);
    await user.type(screen.getByPlaceholderText('qBittorrent'), 'Fail');
    await user.type(screen.getByPlaceholderText('localhost'), 'example.com');
    await user.click(screen.getByRole('button', { name: /Add Client/i }));

    await assertErrorToast('Failed to add download client');
  });

  it('switches to edit mode and updates a client', async () => {
    const user = userEvent.setup();
    (api.updateClient as Mock).mockResolvedValue({ ...mockClients[0], name: 'Updated' });
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByLabelText('Edit My qBittorrent'));
    expect(screen.getByText('Edit Download Client')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('qBittorrent');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated');
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateClient).toHaveBeenCalled();
    });
    const [id, data] = (api.updateClient as Mock).mock.calls[0];
    expect(id).toBe(1);
    expect(data).toMatchObject({ name: 'Updated' });

    await assertSuccessToast('Download client updated');
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.updateClient as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByLabelText('Edit My qBittorrent'));
    await user.click(screen.getByText('Save Changes'));

    await assertErrorToast('Failed to update download client');
  });

  it('opens delete modal and deletes a client', async () => {
    const user = userEvent.setup();
    (api.deleteClient as Mock).mockResolvedValue({});
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await assertDeleteFlow(user, 'My qBittorrent', api.deleteClient as Mock, 1, 'Download client');
  });

  it('cancels delete confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await assertCancelDelete(user, 'My qBittorrent', api.deleteClient as Mock);
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteClient as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await assertDeleteError(user, 'My qBittorrent', 'Download client');
  });

  it('shows validation errors when submitting empty name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByText('Add Client').closest('button')!);
    await user.type(screen.getByPlaceholderText('localhost'), 'example.com');
    await user.click(screen.getByRole('button', { name: /Add Client/i }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
    expect(api.createClient).not.toHaveBeenCalled();
  });

  it('shows validation errors when submitting empty host', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    await user.click(screen.getByText('Add Client').closest('button')!);
    await user.type(screen.getByPlaceholderText('qBittorrent'), 'Test');
    await user.click(screen.getByRole('button', { name: /Add Client/i }));

    await waitFor(() => {
      expect(screen.getByText('Host is required')).toBeInTheDocument();
    });
    expect(api.createClient).not.toHaveBeenCalled();
  });

  it('tests an existing client via the test button', async () => {
    const user = userEvent.setup();
    (api.testClient as Mock).mockResolvedValue({ success: true, message: 'Connected' });
    renderWithProviders(<DownloadClientsSettings />);
    await waitForListLoad('My qBittorrent');

    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(api.testClient).toHaveBeenCalled();
      expect((api.testClient as Mock).mock.calls[0][0]).toBe(1);
    });
  });
});
