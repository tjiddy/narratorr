import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockNotifier } from '@/__tests__/factories';
import { NotifierCard } from './NotifierCard';
import type { Notifier, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';

const mockNotifier: Notifier = createMockNotifier({ id: 1 });

const mockDiscordNotifier: Notifier = createMockNotifier({
  id: 2,
  name: 'Discord',
  type: 'discord',
  events: ['on_grab', 'on_download_complete', 'on_import', 'on_failure'],
  settings: { webhookUrl: 'https://discord.com/api/webhooks/123/abc', includeCover: true },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotifierCard — view mode', () => {
  it('displays notifier name, type, and subtitle', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('My Webhook')).toBeInTheDocument();
    expect(screen.getByText(/Webhook — example\.com/)).toBeInTheDocument();
  });

  it('displays event labels', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Events: Grab, Import')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        onEdit={onEdit}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Edit My Webhook'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('calls onDelete when delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        onDelete={onDelete}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Delete My Webhook'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('calls onTest with notifier id', async () => {
    const onTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        onTest={onTest}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);
    expect(onTest).toHaveBeenCalledWith(1);
  });

  it('shows test result with Sent!/Failed text when id matches', () => {
    const testResult: IdTestResult = { id: 1, success: true, message: '' };

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="view"
        testResult={testResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Sent!')).toBeInTheDocument();
  });

  it('displays new adapter type labels in view mode', () => {
    const telegramNotifier = createMockNotifier({
      id: 3, name: 'My Telegram', type: 'telegram',
      settings: { botToken: '123:ABC', chatId: '-100123' },
    });
    renderWithProviders(
      <NotifierCard notifier={telegramNotifier} mode="view" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );
    expect(screen.getByText(/Telegram — Chat -100123/)).toBeInTheDocument();
  });

  it('shows discord subtitle with truncated URL', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockDiscordNotifier}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText(/Discord — Discord/)).toBeInTheDocument();
  });
});

describe('NotifierCard — create mode', () => {
  it('renders form with Add New Notifier heading', () => {
    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Add New Notifier')).toBeInTheDocument();
  });

  it('shows webhook fields by default', () => {
    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('https://example.com/webhook')).toBeInTheDocument();
    expect(screen.getByText('Method')).toBeInTheDocument();
    expect(screen.getByText('Body Template')).toBeInTheDocument();
  });

  it('shows discord fields when type is changed', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const typeSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(typeSelect, 'discord');

    expect(screen.getByPlaceholderText('https://discord.com/api/webhooks/...')).toBeInTheDocument();
    expect(screen.getByText('Include Cover Image')).toBeInTheDocument();
    expect(screen.queryByText('Method')).not.toBeInTheDocument();
  });

  it('shows script fields when type is changed', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const typeSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(typeSelect, 'script');

    expect(screen.getByPlaceholderText('/path/to/script.sh')).toBeInTheDocument();
    expect(screen.getByText('Timeout (seconds)')).toBeInTheDocument();
  });

  it('shows email fields when type is changed to email', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NotifierCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );

    const typeSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(typeSelect, 'email');

    expect(screen.getByPlaceholderText('smtp.gmail.com')).toBeInTheDocument();
    expect(screen.getByText('From Address')).toBeInTheDocument();
    expect(screen.getByText('To Address')).toBeInTheDocument();
  });

  it('shows event checkboxes with all selected by default', () => {
    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Grab')).toBeInTheDocument();
    expect(screen.getByText('Download Complete')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Failure')).toBeInTheDocument();
    expect(screen.getByText('Upgrade')).toBeInTheDocument();
    expect(screen.getByText('Health Issue')).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    checkboxes.forEach((cb) => expect(cb).toBeChecked());
  });

  it('can toggle event checkboxes', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const grabCheckbox = screen.getByRole('checkbox', { name: 'Grab' });
    await user.click(grabCheckbox);
    expect(grabCheckbox).not.toBeChecked();

    await user.click(grabCheckbox);
    expect(grabCheckbox).toBeChecked();
  });

  it('submits form data', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={onSubmit}
        onFormTest={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText('My Webhook'), 'Test Notifier');
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://hook.example.com');
    await user.click(screen.getByText('Add Notifier'));

    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Test Notifier',
      type: 'webhook',
      settings: expect.objectContaining({ url: 'https://hook.example.com' }),
    });
  });

  it('shows Adding... when isPending', () => {
    renderWithProviders(
      <NotifierCard
        mode="create"
        isPending={true}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Adding...')).toBeInTheDocument();
  });

  it('shows form test result', () => {
    const formTestResult: TestResult = { success: false, message: 'Timeout' };

    renderWithProviders(
      <NotifierCard
        mode="create"
        formTestResult={formTestResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Timeout')).toBeInTheDocument();
  });
});

describe('NotifierCard — edit mode', () => {
  it('renders form with Edit Notifier heading and pre-filled data', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit Notifier')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('My Webhook')).toHaveValue('My Webhook');
  });

  it('shows enabled field in edit mode', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('shows cancel button and calls onCancel', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onCancel={onCancel}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows Save Changes / Saving...', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('pre-fills event checkboxes from notifier data', () => {
    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const grabCb = screen.getByRole('checkbox', { name: 'Grab' });
    const importCb = screen.getByRole('checkbox', { name: 'Import' });
    const downloadCb = screen.getByRole('checkbox', { name: 'Download Complete' });
    const failureCb = screen.getByRole('checkbox', { name: 'Failure' });

    expect(grabCb).toBeChecked();
    expect(importCb).toBeChecked();
    expect(downloadCb).not.toBeChecked();
    expect(failureCb).not.toBeChecked();
  });

  it('hydrates edit form with registry defaults for missing settings fields', () => {
    const notifierWithSparseSettings = createMockNotifier({
      id: 10,
      name: 'Sparse Webhook',
      type: 'webhook',
      settings: { url: 'https://saved.com/hook' },
    });

    renderWithProviders(
      <NotifierCard
        notifier={notifierWithSparseSettings}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const urlInput = screen.getByPlaceholderText('https://example.com/webhook');
    expect(urlInput).toHaveValue('https://saved.com/hook');
    expect(screen.getByText('Body Template')).toBeInTheDocument();
    expect(screen.getByText('Headers (JSON)')).toBeInTheDocument();
  });

  it('create-mode defaults derive from NOTIFIER_TYPES[0] registry entry', () => {
    renderWithProviders(
      <NotifierCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );

    expect(screen.getByPlaceholderText('https://example.com/webhook')).toBeInTheDocument();
    expect(screen.getByText('Method')).toBeInTheDocument();
    expect(screen.getByText('Headers (JSON)')).toBeInTheDocument();
    expect(screen.getByText('Body Template')).toBeInTheDocument();
  });
});
