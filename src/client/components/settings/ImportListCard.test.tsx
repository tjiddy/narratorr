import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportListCard } from './ImportListCard';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType } from '../../../shared/import-list-registry.js';
import type { ImportList } from '@/lib/api';
import type { Mock } from 'vitest';

// Every settings key declared by an import-list type OTHER than `ownType`, minus any key
// `ownType` also declares (e.g. all three share `apiKey`). Registry-derived so the #908
// guard covers new provider types — and the full foreign set, not just the prior type's
// keys — without test edits.
function foreignImportListKeys(ownType: ImportListType): string[] {
  const ownKeys = new Set(Object.keys(IMPORT_LIST_REGISTRY[ownType].defaultSettings));
  return [
    ...new Set(
      IMPORT_LIST_TYPES.filter((t) => t !== ownType)
        .flatMap((t) => Object.keys(IMPORT_LIST_REGISTRY[t].defaultSettings))
        .filter((k) => !ownKeys.has(k)),
    ),
  ];
}

vi.mock('@/lib/api', () => ({
  api: {
    updateImportList: vi.fn(),
    previewImportList: vi.fn(),
    getImportLists: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockList: ImportList = {
  id: 1,
  name: 'My ABS List',
  type: 'abs',
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { serverUrl: 'http://abs.local', apiKey: '***', libraryId: 'lib-1' },
  lastRunAt: null,
  nextRunAt: null,
  lastSyncError: null,
  createdAt: '2024-01-01T00:00:00Z',
};

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportListCard', () => {
  describe('view mode', () => {
    it('renders list info with name, type label, and sync interval', () => {
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      expect(screen.getByText('My ABS List')).toBeInTheDocument();
      expect(screen.getByText(/Audiobookshelf/)).toBeInTheDocument();
      expect(screen.getByText(/every 1440m/)).toBeInTheDocument();
    });

    it('shows enabled indicator when list is enabled', () => {
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      // Green check circle for enabled
      const toggleButton = screen.getByText('My ABS List').closest('.flex')!.querySelector('button')!;
      expect(toggleButton.querySelector('.text-green-500')).not.toBeNull();
    });

    it('shows disabled indicator when list is disabled', () => {
      renderWithProviders(
        <ImportListCard list={{ ...mockList, enabled: false }} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My ABS List').closest('.flex')!.querySelector('button')!;
      expect(toggleButton.querySelector('.text-muted-foreground')).not.toBeNull();
    });

    it('toggle calls API to disable an enabled list', async () => {
      const user = userEvent.setup();
      (api.updateImportList as Mock).mockResolvedValue({ ...mockList, enabled: false });
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My ABS List').closest('.flex')!.querySelector('button')!;
      await user.click(toggleButton);

      await waitFor(() => {
        expect(api.updateImportList).toHaveBeenCalledWith(1, { enabled: false });
      });
    });

    it('toggle calls API to enable a disabled list', async () => {
      const user = userEvent.setup();
      (api.updateImportList as Mock).mockResolvedValue({ ...mockList, enabled: true });
      renderWithProviders(
        <ImportListCard list={{ ...mockList, enabled: false }} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My ABS List').closest('.flex')!.querySelector('button')!;
      await user.click(toggleButton);

      await waitFor(() => {
        expect(api.updateImportList).toHaveBeenCalledWith(1, { enabled: true });
      });
    });

    it('shows error toast when toggle fails', async () => {
      const user = userEvent.setup();
      (api.updateImportList as Mock).mockRejectedValue(new Error('fail'));
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My ABS List').closest('.flex')!.querySelector('button')!;
      await user.click(toggleButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to toggle import list');
      });
    });

    it('shows last sync error when present', () => {
      renderWithProviders(
        <ImportListCard list={{ ...mockList, lastSyncError: 'Connection refused' }} mode="view" onSubmit={noop} />
      );

      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });

    it('edit button calls onEdit handler', async () => {
      const user = userEvent.setup();
      const onEdit = vi.fn();
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onEdit={onEdit} onSubmit={noop} />
      );

      await user.click(screen.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledOnce();
    });

    it('delete button calls onDelete handler', async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onDelete={onDelete} onSubmit={noop} />
      );

      // Delete button is the last button in the row, identifiable by its trash icon child
      const allButtons = screen.getAllByRole('button');
      const deleteBtn = allButtons.find(btn => btn.querySelector('svg.w-4.h-4') !== null && btn.closest('.flex.items-center.gap-2'));
      expect(deleteBtn).toBeDefined();
      await user.click(deleteBtn!);
      expect(onDelete).toHaveBeenCalledOnce();
    });
  });

  describe('create mode', () => {
    it('renders form with name, type selector, provider settings, sync interval', () => {
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} />
      );

      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Provider Type')).toBeInTheDocument();
      expect(screen.getByLabelText('Sync Interval (minutes)')).toBeInTheDocument();
      // ABS fields shown by default
      expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    });

    it('sync interval input uses integer step', () => {
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} />
      );

      expect(screen.getByLabelText('Sync Interval (minutes)').getAttribute('step')).toBe('1');
    });

    it('Test Connection calls onFormTest with current form data', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalledWith(expect.objectContaining({
        type: 'abs',
        enabled: true,
      }));
    });

    it('shows test success feedback from formTestResult', () => {
      renderWithProviders(
        <ImportListCard
          mode="create"
          onSubmit={noop}
          formTestResult={{ success: true }}
        />
      );

      expect(screen.getByText('Connection OK')).toBeInTheDocument();
    });

    it('shows test failure feedback from formTestResult', () => {
      renderWithProviders(
        <ImportListCard
          mode="create"
          onSubmit={noop}
          formTestResult={{ success: false, message: 'Invalid API key' }}
        />
      );

      expect(screen.getByText('Invalid API key')).toBeInTheDocument();
    });

    it('switching provider type clears stale test feedback', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <ImportListCard
          mode="create"
          onSubmit={noop}
          formTestResult={{ success: true }}
        />
      );

      // Test result should be visible initially
      expect(screen.getByText('Connection OK')).toBeInTheDocument();

      // Switch provider type
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');

      // Test result should be hidden after provider change
      expect(screen.queryByText('Connection OK')).not.toBeInTheDocument();
    });

    it('new test after provider switch restores feedback visibility', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard
          mode="create"
          onSubmit={noop}
          onFormTest={onFormTest}
          formTestResult={{ success: true }}
        />
      );

      // Switch provider to hide stale result
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      expect(screen.queryByText('Connection OK')).not.toBeInTheDocument();

      // Click Test Connection — clears stale flag, feedback should reappear
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(onFormTest).toHaveBeenCalledWith(expect.objectContaining({ type: 'nyt' }));

      // formTestResult prop is still { success: true } — now visible again after stale flag cleared
      expect(screen.getByText('Connection OK')).toBeInTheDocument();
    });

    it('Preview Items calls API and displays results', async () => {
      const user = userEvent.setup();
      (api.previewImportList as Mock).mockResolvedValue({
        items: [{ title: 'Book One', author: 'Author A' }],
        total: 5,
      });
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} />
      );

      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => {
        expect(screen.getByText('Book One')).toBeInTheDocument();
      });
      expect(screen.getByText(/by Author A/)).toBeInTheDocument();
      expect(screen.getByText('Showing 1 of 5 items')).toBeInTheDocument();
    });

    // #844 — id forwarding for sentinel resolution
    it('Preview Items omits id on the create-mode path', async () => {
      const user = userEvent.setup();
      (api.previewImportList as Mock).mockResolvedValue({ items: [], total: 0 });
      renderWithProviders(<ImportListCard mode="create" onSubmit={noop} />);

      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => expect(api.previewImportList).toHaveBeenCalled());
      const call = (api.previewImportList as Mock).mock.calls[0]![0];
      expect(call).not.toHaveProperty('id');
    });

    it('Preview Items shows error toast on failure', async () => {
      const user = userEvent.setup();
      (api.previewImportList as Mock).mockRejectedValue(new Error('fail'));
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} />
      );

      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Preview failed — check your settings');
      });
    });

    it('submit button calls onSubmit with form data', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={onSubmit} />
      );

      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Test List');
      await user.click(screen.getByText('Add Import List', { selector: 'button[type="submit"]' }));

      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Test List',
        type: 'abs',
      }));
    });

    it('cancel button calls onCancel', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onCancel={onCancel} />
      );

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('submit button shows pending state when isPending', () => {
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} isPending />
      );

      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
  });

  describe('edit mode', () => {
    it('renders form without type selector (provider immutable)', () => {
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={noop} />
      );

      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.queryByLabelText('Provider Type')).not.toBeInTheDocument();
    });

    it('pre-fills form with existing list data', () => {
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={noop} />
      );

      expect(screen.getByDisplayValue('My ABS List')).toBeInTheDocument();
      expect(screen.getByDisplayValue('1440')).toBeInTheDocument();
    });

    it('Test Connection calls onTest with list ID', async () => {
      const user = userEvent.setup();
      const onTest = vi.fn();
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={noop} onTest={onTest} />
      );

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(onTest).toHaveBeenCalledWith(1);
    });

    // #1057 — non-regression: import-list edit-mode test must use the saved-id flow
    // (onTest(initial.id) / /import-lists/:id/test) and MUST NOT route through the
    // generic test-by-config payload path. The centralization in #1057 explicitly
    // opts out of import lists.
    it('#1057 edit-mode Test fires onTest(initial.id) and does NOT call onFormTest', async () => {
      const user = userEvent.setup();
      const onTest = vi.fn();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard
          list={mockList}
          mode="edit"
          onSubmit={noop}
          onTest={onTest}
          onFormTest={onFormTest}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(onTest).toHaveBeenCalledWith(1);
      expect(onFormTest).not.toHaveBeenCalled();
    });

    it('shows test result from testResult prop when testResult.id matches', () => {
      renderWithProviders(
        <ImportListCard
          list={mockList}
          mode="edit"
          onSubmit={noop}
          testResult={{ id: 1, success: true }}
        />
      );

      expect(screen.getByText('Connection OK')).toBeInTheDocument();
    });

    it('submit button calls onSubmit with updated form data', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={onSubmit} />
      );

      const nameInput = screen.getByDisplayValue('My ABS List');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated List');
      await user.click(screen.getByText('Update', { selector: 'button[type="submit"]' }));

      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Updated List',
        type: 'abs',
      }));
    });

    // #844 — id forwarding for sentinel resolution
    it('Preview Items forwards initial.id when editing an existing list', async () => {
      const user = userEvent.setup();
      (api.previewImportList as Mock).mockResolvedValue({ items: [], total: 0 });
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={noop} />
      );

      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => expect(api.previewImportList).toHaveBeenCalled());
      expect(api.previewImportList).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, type: 'abs' }),
      );
    });
  });

  // #908 family — registry-overlay leak guard (siblings: IndexerCard.test.tsx,
  // DownloadClientForm.test.tsx, NotifierCard.test.tsx). ImportListCard has NO
  // `settingsFromImportList` helper and none should be added — its leak-prevention
  // mechanism is `handleTypeChange` (ImportListCard.tsx:173), which resets `settings`
  // to the newly selected type's `defaultSettings` on a create-mode provider switch.
  // The provider-type selector is rendered only in create mode (ImportListCard.tsx:228,
  // `{!initial && …}`), so create mode is the only surface that both exposes the switch
  // and routes Test through the `onFormTest(formData)` payload path. Edit mode is
  // covered by the separate #1057 saved-id test above and must NOT be normalized into
  // this payload pattern. Regress the guard by removing the `setSettings` reset in
  // `handleTypeChange` and these assertions go red.
  describe('#908 — ImportListCard handleTypeChange registry reset (no foreign-type leak)', () => {
    it('abs → nyt switch drops abs-only keys from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      // Populate abs-only settings before switching, so the reset is proven to drop
      // real stored values — not merely empty registry defaults.
      await user.type(screen.getByLabelText('Server URL'), 'http://abs.local');
      await user.type(screen.getByLabelText('Library'), 'lib-42');

      // Switch provider type — handleTypeChange resets settings to nyt defaults.
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalled();
      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      // No key from any non-nyt provider may survive the switch — covers abs (serverUrl/
      // libraryId) AND hardcover (listType), matching the full no-foreign-keys contract.
      const foreignKeys = foreignImportListKeys('nyt');
      expect(foreignKeys).toEqual(expect.arrayContaining(['serverUrl', 'libraryId', 'listType']));
      for (const key of foreignKeys) {
        expect(payloadSettings).not.toHaveProperty(key);
      }

      // nyt defaults MUST be present (value-checked so the reset is confirmed).
      expect(payloadSettings).toHaveProperty('list', 'audio-fiction');
      expect(payloadSettings).toHaveProperty('apiKey', '');
    });

    it('nyt → abs switch drops the nyt-only list key from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      // Switch to nyt and set a non-default Bestseller List value.
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      await user.selectOptions(screen.getByLabelText('Bestseller List'), 'audio-nonfiction');

      // Switch back to abs — handleTypeChange resets settings to abs defaults.
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'abs');

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalled();
      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      // No key from any non-abs provider may survive the switch — covers nyt (list) AND
      // hardcover (listType), matching the full no-foreign-keys contract.
      const foreignKeys = foreignImportListKeys('abs');
      expect(foreignKeys).toEqual(expect.arrayContaining(['list', 'listType']));
      for (const key of foreignKeys) {
        expect(payloadSettings).not.toHaveProperty(key);
      }

      // abs defaults MUST be present.
      expect(payloadSettings).toHaveProperty('serverUrl', '');
      expect(payloadSettings).toHaveProperty('libraryId', '');
    });
  });
});
