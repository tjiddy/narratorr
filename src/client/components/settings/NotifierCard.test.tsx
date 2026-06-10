import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockNotifier } from '@/__tests__/factories';
import { NotifierCard } from './NotifierCard';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES, type NotifierType } from '../../../shared/notifier-registry.js';
import type { Notifier, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';

// Every settings key declared by a notifier type OTHER than `ownType`, minus any key
// `ownType` also declares (e.g. slack/discord both use `webhookUrl`). Registry-derived so
// the #908 guard automatically covers new notifier types without test edits.
function foreignNotifierKeys(ownType: NotifierType): string[] {
  const ownKeys = new Set(Object.keys(NOTIFIER_REGISTRY[ownType].defaultSettings));
  return [
    ...new Set(
      NOTIFIER_TYPES.filter((t) => t !== ownType)
        .flatMap((t) => Object.keys(NOTIFIER_REGISTRY[t].defaultSettings))
        .filter((k) => !ownKeys.has(k)),
    ),
  ];
}

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

  it('shows discord subtitle as static label', () => {
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

  it('shows ntfy subtitle as server hostname when settings are server-masked', () => {
    const ntfyNotifier = createMockNotifier({
      id: 4, name: 'My Ntfy', type: 'ntfy',
      settings: { ntfyTopic: '********', ntfyServer: 'https://ntfy.example.com' },
    });
    renderWithProviders(
      <NotifierCard notifier={ntfyNotifier} mode="view" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );

    expect(screen.getByText(/ntfy — ntfy\.example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/\*{8}/)).not.toBeInTheDocument();
  });

  it('shows ntfy subtitle as ntfy.sh fallback when server is unset', () => {
    const ntfyNotifier = createMockNotifier({
      id: 5, name: 'My Ntfy', type: 'ntfy',
      settings: { ntfyTopic: '********', ntfyServer: '' },
    });
    renderWithProviders(
      <NotifierCard notifier={ntfyNotifier} mode="view" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );

    expect(screen.getByText(/ntfy — ntfy\.sh/)).toBeInTheDocument();
    expect(screen.queryByText(/\*{8}/)).not.toBeInTheDocument();
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
    await user.selectOptions(typeSelect!, 'discord');

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
    await user.selectOptions(typeSelect!, 'script');

    expect(screen.getByPlaceholderText('/path/to/script.sh')).toBeInTheDocument();
    expect(screen.getByText('Timeout (seconds)')).toBeInTheDocument();
  });

  it('shows email fields when type is changed to email', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NotifierCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );

    const typeSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(typeSelect!, 'email');

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
    expect(screen.getByText('Health Issue')).toBeInTheDocument();
    expect(screen.queryByText('Upgrade')).not.toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(5);
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
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
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

  it('#1057 in edit mode, clicking Test posts raw form data (no id) — shared hook injects id downstream', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={mockNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);

    expect(onFormTest).toHaveBeenCalled();
    expect(onFormTest.mock.calls[0]![0]).toMatchObject({ type: mockNotifier.type });
    expect(onFormTest.mock.calls[0]![0]).not.toHaveProperty('id');
  });

  it('#731 in create mode, clicking Test posts no id', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    // Fill all required webhook fields so the form passes validation and reaches onFormTest
    await user.type(screen.getByPlaceholderText('My Webhook'), 'New Notifier');
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://hook.example.com');
    await user.click(screen.getByText('Test').closest('button')!);

    expect(onFormTest).toHaveBeenCalled();
    const callArg = onFormTest.mock.calls[0]![0];
    expect('id' in callArg).toBe(false);
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

// #1103 F7 — empty-events notifier UX. After the migration scrub, an on_upgrade-only
// notifier row ends up with events: [] and enabled: false. The component must:
//   - show the no-events hint in view mode
//   - disable the Enabled toggle in edit mode while events.length === 0
//   - surface the 'Select at least one event' validation message when the user tries
//     to save the edit form without selecting an event
describe('NotifierCard — empty-events notifier (#1103 F7)', () => {
  const emptyEventsNotifier: Notifier = createMockNotifier({
    id: 99,
    name: 'Migrated Notifier',
    type: 'webhook',
    enabled: false,
    events: [],
    settings: { url: 'https://example.com/hook', method: 'POST' },
  });

  it('view mode renders the "no events selected" hint instead of the Events line', () => {
    renderWithProviders(
      <NotifierCard
        notifier={emptyEventsNotifier}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    // The empty-events hint replaces the normal `Events: ...` line.
    expect(screen.getByTestId('notifier-empty-events-hint')).toHaveTextContent(
      /No events selected/i,
    );
    expect(screen.queryByText(/^Events:/)).not.toBeInTheDocument();
  });

  it('edit-mode Enabled checkbox is disabled while events array is empty', () => {
    renderWithProviders(
      <NotifierCard
        notifier={emptyEventsNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const enabledCheckbox = screen.getByRole('checkbox', { name: 'Enabled' });
    expect(enabledCheckbox).toBeDisabled();
    // Hint text describes WHY the toggle is disabled — visible to the user.
    expect(screen.getByText(/Select at least one event to enable this notifier/i)).toBeInTheDocument();
  });

  it('edit-mode Enabled checkbox becomes enabled after the user selects an event', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <NotifierCard
        notifier={emptyEventsNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeDisabled();

    // Pick any event.
    await user.click(screen.getByRole('checkbox', { name: 'Grab' }));

    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeDisabled();
    expect(screen.queryByText(/Select at least one event to enable this notifier/i)).not.toBeInTheDocument();
  });

  it('submitting the edit form with no events selected surfaces "Select at least one event" and blocks onSubmit', async () => {
    const onSubmit = vi.fn();

    renderWithProviders(
      <NotifierCard
        notifier={emptyEventsNotifier}
        mode="edit"
        onSubmit={onSubmit}
        onFormTest={vi.fn()}
      />,
    );

    const form = screen.getByText('Edit Notifier').closest('form')!;
    fireEvent.submit(form);

    // Zod's events.min(1, 'Select at least one event') fires; the error text appears in red below the events list.
    expect(await screen.findByText('Select at least one event')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// #908 family — settingsFromX registry-overlay guard (siblings: IndexerCard.test.tsx,
// DownloadClientForm.test.tsx). NotifierCard hydrates edit-mode settings via the
// `settingsFromNotifier` registry overlay (NotifierCard.tsx:32-40): it seeds from the
// entity type's `defaultSettings` and overlays only non-null stored values, so a webhook
// entity hydrates to webhook keys only and a discord entity to discord keys only.
//
// This suite mirrors the IndexerCard reference shape EXACTLY: no-switch, per-type. Each
// case renders edit mode with an entity of one type and immediately fires Test — it never
// switches the type selector. That is deliberate: the settings reset in NotifierCard.tsx:92-97
// is create-mode only, so an in-edit type switch would leave stale source-type keys in RHF
// state. The overlay is validated at hydration, per type, instead. No production change is
// needed — the existing overlay already prevents the leak (regress it by seeding from a union
// of all types' defaults and these assertions go red).
describe('NotifierCard — #908 settingsFromNotifier registry overlay (no foreign-type leak)', () => {
  it('webhook entity edit Test payload preserves webhook keys and leaks no foreign-type keys', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();
    const webhookNotifier: Notifier = createMockNotifier({
      id: 200,
      name: 'Webhook No Leak',
      type: 'webhook',
      settings: { url: 'https://hook.example.com', method: 'POST', bodyTemplate: '{{title}}' },
    });

    renderWithProviders(
      <NotifierCard
        notifier={webhookNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);

    await waitFor(() => {
      expect(onFormTest).toHaveBeenCalled();
    });

    const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

    // Stored webhook-specific keys MUST round-trip (value-checked so a default can't masquerade).
    expect(payloadSettings).toHaveProperty('url', 'https://hook.example.com');
    expect(payloadSettings).toHaveProperty('method', 'POST');
    expect(payloadSettings).toHaveProperty('bodyTemplate', '{{title}}');

    // NO key from ANY other notifier type may leak — AC1/CLAUDE.md require the selected
    // type's payload to carry no foreign keys (the strict per-type server schema rejects them).
    // Covers discord (webhookUrl/includeCover) plus script/email/telegram/slack/pushover/ntfy/gotify.
    const foreignKeys = foreignNotifierKeys('webhook');
    expect(foreignKeys).toContain('webhookUrl');
    expect(foreignKeys).toContain('botToken');
    for (const key of foreignKeys) {
      expect(payloadSettings).not.toHaveProperty(key);
    }
  });

  it('discord entity edit Test payload preserves discord keys and leaks no foreign-type keys', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();
    const discordNotifier: Notifier = createMockNotifier({
      id: 201,
      name: 'Discord No Leak',
      type: 'discord',
      settings: { webhookUrl: 'https://discord.com/api/webhooks/x', includeCover: false },
    });

    renderWithProviders(
      <NotifierCard
        notifier={discordNotifier}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);

    await waitFor(() => {
      expect(onFormTest).toHaveBeenCalled();
    });

    const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

    // Stored discord-specific keys MUST round-trip — includeCover:false is non-default,
    // so the overlay (not the registry default of true) must win.
    expect(payloadSettings).toHaveProperty('webhookUrl', 'https://discord.com/api/webhooks/x');
    expect(payloadSettings).toHaveProperty('includeCover', false);

    // NO key from ANY other notifier type may leak. `webhookUrl` is shared with slack so it
    // is the discord type's own key (correctly excluded); webhook keys (url/method/headers/
    // bodyTemplate) plus script/email/telegram/pushover/ntfy/gotify keys MUST all be absent.
    const foreignKeys = foreignNotifierKeys('discord');
    expect(foreignKeys).toContain('url');
    expect(foreignKeys).not.toContain('webhookUrl');
    for (const key of foreignKeys) {
      expect(payloadSettings).not.toHaveProperty(key);
    }
  });
});
