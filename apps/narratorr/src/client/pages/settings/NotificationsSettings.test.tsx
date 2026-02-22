import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockNotifier } from '@/__tests__/factories';
import { NotificationsSettings } from './NotificationsSettings';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getNotifiers: vi.fn(),
    createNotifier: vi.fn(),
    updateNotifier: vi.fn(),
    deleteNotifier: vi.fn(),
    testNotifier: vi.fn(),
    testNotifierConfig: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockNotifiers = [
  createMockNotifier({
    id: 1,
    name: 'My Discord',
    type: 'discord',
    events: ['on_grab', 'on_download_complete'],
    settings: { webhookUrl: 'https://discord.com/api/webhooks/123', includeCover: true },
  }),
  createMockNotifier({
    id: 2,
    name: 'My Webhook',
    enabled: false,
    events: ['on_grab'],
    settings: { url: 'https://example.com/hook', method: 'POST', headers: '', bodyTemplate: '' },
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.getNotifiers as Mock).mockResolvedValue(mockNotifiers);
});

describe('NotificationsSettings', () => {
  it('renders header and notifier list', async () => {
    renderWithProviders(<NotificationsSettings />);

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });
    expect(screen.getByText('My Webhook')).toBeInTheDocument();
  });

  it('shows empty state when no notifiers exist', async () => {
    (api.getNotifiers as Mock).mockResolvedValue([]);
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No notifications configured')).toBeInTheDocument();
    });
  });

  it('toggles add form when Add Notifier button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    expect(screen.getByText('Add New Notifier')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel').closest('button')!);
    expect(screen.queryByText('Add New Notifier')).not.toBeInTheDocument();
  });

  it('creates a new notifier', async () => {
    const user = userEvent.setup();
    (api.createNotifier as Mock).mockResolvedValue({ id: 3, name: 'New', type: 'discord', enabled: true, events: [], settings: {}, createdAt: '2024-01-01T00:00:00Z' });
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    await user.type(screen.getByPlaceholderText('My Webhook'), 'New Discord');
    // Default type is webhook — switch to discord. Multiple selects exist (type + method), target by name.
    const typeSelect = document.querySelector('select[name="type"]') as HTMLSelectElement;
    await user.selectOptions(typeSelect, 'discord');
    await user.type(screen.getByPlaceholderText('https://discord.com/api/webhooks/...'), 'https://discord.com/api/webhooks/999');

    await user.click(screen.getByRole('button', { name: /Add Notifier/i }));

    await waitFor(() => {
      expect(api.createNotifier).toHaveBeenCalled();
    });
    expect((api.createNotifier as Mock).mock.calls[0][0]).toMatchObject({
      name: 'New Discord',
      type: 'discord',
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Notifier added successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    await user.type(screen.getByPlaceholderText('My Webhook'), 'Fail');
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://example.com');

    await user.click(screen.getByRole('button', { name: /Add Notifier/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add notifier');
    });
  });

  it('switches to edit mode and updates a notifier', async () => {
    const user = userEvent.setup();
    (api.updateNotifier as Mock).mockResolvedValue({ ...mockNotifiers[0], name: 'Updated' });
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Edit My Discord'));
    expect(screen.getByText('Edit Notifier')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('My Webhook');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated');
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateNotifier).toHaveBeenCalled();
    });
    const [id, data] = (api.updateNotifier as Mock).mock.calls[0];
    expect(id).toBe(1);
    expect(data).toMatchObject({ name: 'Updated' });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Notifier updated');
    });
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.updateNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Edit My Discord'));
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update notifier');
    });
  });

  it('opens delete modal and deletes a notifier', async () => {
    const user = userEvent.setup();
    (api.deleteNotifier as Mock).mockResolvedValue({});
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My Discord'));

    const dialog = screen.getByRole('dialog');
    expect(screen.getByText(/Are you sure you want to delete "My Discord"/)).toBeInTheDocument();

    const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Delete',
    )!;
    await user.click(confirmButton);

    await waitFor(() => {
      expect((api.deleteNotifier as Mock).mock.calls[0][0]).toBe(1);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Notifier removed successfully');
    });
  });

  it('cancels delete confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My Discord'));
    await user.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.deleteNotifier).not.toHaveBeenCalled();
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My Discord'));

    const dialog = screen.getByRole('dialog');
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Delete',
    )!;
    await user.click(confirmButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete notifier');
    });
  });

  it('shows validation errors when submitting empty name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    // Fill URL but leave name empty
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://example.com');
    await user.click(screen.getByRole('button', { name: /Add Notifier/i }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
    expect(api.createNotifier).not.toHaveBeenCalled();
  });

  it('shows validation errors when submitting without required settings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    // Fill name but leave URL empty (webhook type requires url)
    await user.type(screen.getByPlaceholderText('My Webhook'), 'Test');
    await user.click(screen.getByRole('button', { name: /Add Notifier/i }));

    await waitFor(() => {
      expect(screen.getByText('URL is required')).toBeInTheDocument();
    });
    expect(api.createNotifier).not.toHaveBeenCalled();
  });

  it('tests an existing notifier', async () => {
    const user = userEvent.setup();
    (api.testNotifier as Mock).mockResolvedValue({ success: true, message: 'Sent' });
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(api.testNotifier).toHaveBeenCalled();
      expect((api.testNotifier as Mock).mock.calls[0][0]).toBe(1);
    });
  });
});
