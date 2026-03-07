import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockNotifier } from '@/__tests__/factories';
import {
  waitForListLoad,
  assertDeleteFlow,
  assertCancelDelete,
  assertDeleteError,
  assertToggleAddForm,
  assertSuccessToast,
  assertErrorToast,
} from '@/__tests__/crud-settings-helpers';
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
    await waitForListLoad('My Discord');
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
    await waitForListLoad('My Discord');

    await assertToggleAddForm(user, 'Add Notifier', 'Add New Notifier');
  });

  it('creates a new notifier', async () => {
    const user = userEvent.setup();
    (api.createNotifier as Mock).mockResolvedValue({ id: 3, name: 'New', type: 'discord', enabled: true, events: [], settings: {}, createdAt: '2024-01-01T00:00:00Z' });
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

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

    await assertSuccessToast('Notifier added successfully');
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await user.click(screen.getByText('Add Notifier').closest('button')!);
    await user.type(screen.getByPlaceholderText('My Webhook'), 'Fail');
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://example.com');
    await user.click(screen.getByRole('button', { name: /Add Notifier/i }));

    await assertErrorToast('Failed to add notifier');
  });

  it('switches to edit mode and updates a notifier', async () => {
    const user = userEvent.setup();
    (api.updateNotifier as Mock).mockResolvedValue({ ...mockNotifiers[0], name: 'Updated' });
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

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

    await assertSuccessToast('Notifier updated');
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.updateNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await user.click(screen.getByLabelText('Edit My Discord'));
    await user.click(screen.getByText('Save Changes'));

    await assertErrorToast('Failed to update notifier');
  });

  it('opens delete modal and deletes a notifier', async () => {
    const user = userEvent.setup();
    (api.deleteNotifier as Mock).mockResolvedValue({});
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await assertDeleteFlow(user, 'My Discord', api.deleteNotifier as Mock, 1, 'Notifier');
  });

  it('cancels delete confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await assertCancelDelete(user, 'My Discord', api.deleteNotifier as Mock);
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteNotifier as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await assertDeleteError(user, 'My Discord', 'Notifier');
  });

  it('shows validation errors when submitting empty name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);
    await waitForListLoad('My Discord');

    await user.click(screen.getByText('Add Notifier').closest('button')!);
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
    await waitForListLoad('My Discord');

    await user.click(screen.getByText('Add Notifier').closest('button')!);
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
    await waitForListLoad('My Discord');

    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(api.testNotifier).toHaveBeenCalled();
      expect((api.testNotifier as Mock).mock.calls[0][0]).toBe(1);
    });
  });
});
