import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { foreignRegistryKeys } from '@/__tests__/registry-foreign-keys';
import { ImportListCard } from './ImportListCard';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType } from '@shared/import-list-registry.js';
import type { ImportList } from '@/lib/api';
import type { Mock } from 'vitest';

// Registry defaults omit dynamic shelfId, so tests assert it separately.
const foreignImportListKeys = (ownType: ImportListType): string[] =>
  foreignRegistryKeys(ownType, IMPORT_LIST_TYPES, IMPORT_LIST_REGISTRY);

// Spread the real barrel: the card imports `ApiError` at RUNTIME to classify a 409, and a
// replacing factory would land it as `undefined` — visible only on the error path.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    updateImportList: vi.fn(),
    previewImportList: vi.fn(),
    runImportList: vi.fn(),
    getImportLists: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';

const mockList: ImportList = {
  id: 1,
  name: 'My NYT List',
  type: 'nyt',
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { apiKey: '***', list: 'audio-fiction' },
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

      expect(screen.getByText('My NYT List')).toBeInTheDocument();
      expect(screen.getByText(/NYT Bestsellers/)).toBeInTheDocument();
      expect(screen.getByText(/every 1440m/)).toBeInTheDocument();
    });

    it('shows enabled indicator when list is enabled', () => {
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My NYT List').closest('.flex')!.querySelector('button')!;
      expect(toggleButton.querySelector('.text-green-500')).not.toBeNull();
    });

    it('shows disabled indicator when list is disabled', () => {
      renderWithProviders(
        <ImportListCard list={{ ...mockList, enabled: false }} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My NYT List').closest('.flex')!.querySelector('button')!;
      expect(toggleButton.querySelector('.text-muted-foreground')).not.toBeNull();
    });

    it('toggle calls API to disable an enabled list', async () => {
      const user = userEvent.setup();
      (api.updateImportList as Mock).mockResolvedValue({ ...mockList, enabled: false });
      renderWithProviders(
        <ImportListCard list={mockList} mode="view" onSubmit={noop} />
      );

      const toggleButton = screen.getByText('My NYT List').closest('.flex')!.querySelector('button')!;
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

      const toggleButton = screen.getByText('My NYT List').closest('.flex')!.querySelector('button')!;
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

      const toggleButton = screen.getByText('My NYT List').closest('.flex')!.querySelector('button')!;
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

      // The icon-only delete button is identifiable only by its trash icon.
      const allButtons = screen.getAllByRole('button');
      const deleteBtn = allButtons.find(btn => btn.querySelector('svg.w-4.h-4') !== null && btn.closest('.flex.items-center.gap-2'));
      expect(deleteBtn).toBeDefined();
      await user.click(deleteBtn!);
      expect(onDelete).toHaveBeenCalledOnce();
    });
  });

  describe('Run control (#2306)', () => {
    const okCounts = { success: true as const, createdCount: 2, heldReviewCount: 1, excludedCount: 3 };

    function renderRow(list: ImportList = mockList) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
      const utils = renderWithProviders(
        <ImportListCard list={list} mode="view" onSubmit={noop} />,
        { queryClient: client },
      );
      return { ...utils, client, invalidateQueries };
    }

    const runButton = () => screen.getByRole('button', { name: /^Run$/ });

    const expectListsInvalidated = (invalidateQueries: ReturnType<typeof vi.spyOn>) =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.importLists() });

    it('syncs this list exactly once when clicked', async () => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockResolvedValue(okCounts);
      renderRow();

      await user.click(runButton());

      await waitFor(() => expect(api.runImportList).toHaveBeenCalledWith(1));
      expect(api.runImportList).toHaveBeenCalledTimes(1);
    });

    it('reports the created / held / excluded counts on success and raises no error or info', async () => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockResolvedValue(okCounts);
      const { invalidateQueries } = renderRow();

      await user.click(runButton());

      // Exact message, so swapping created/held/excluded reds this — the three values are
      // distinct precisely so the label they sit behind is observable.
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
        'Sync complete — 2 added, 1 held for review, 3 excluded',
      ));
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expectListsInvalidated(invalidateQueries);
    });

    it('reports a sync that failed server-side as an error, not as info', async () => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockResolvedValue({ success: false, message: 'Connection timeout' });
      const { invalidateQueries } = renderRow();

      await user.click(runButton());

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Connection timeout'));
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expectListsInvalidated(invalidateQueries);
    });

    it('reports a 409 refusal as info carrying the server message, not as an error', async () => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockRejectedValue(
        new ApiError(409, { error: 'Task "import-list-sync" is already running' }),
      );
      const { invalidateQueries } = renderRow();

      await user.click(runButton());

      await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Task "import-list-sync" is already running'));
      expect(toast.error).not.toHaveBeenCalled();
      expectListsInvalidated(invalidateQueries);
    });

    it.each([404, 500])('reports an ApiError(%i) as an error, never as info', async (status) => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockRejectedValue(new ApiError(status, { error: `boom ${status}` }));
      const { invalidateQueries } = renderRow();

      await user.click(runButton());

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`boom ${status}`));
      expect(toast.info).not.toHaveBeenCalled();
      expectListsInvalidated(invalidateQueries);
    });

    it('reports a status-less network failure as an error without crashing', async () => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockRejectedValue(new Error('Network down'));
      const { invalidateQueries } = renderRow();

      await user.click(runButton());

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Network down'));
      expect(toast.info).not.toHaveBeenCalled();
      expect(screen.getByText('My NYT List')).toBeInTheDocument();
      expectListsInvalidated(invalidateQueries);
    });

    it('disables the control while the run is in flight and swallows a second click', async () => {
      const user = userEvent.setup();
      let settle!: (value: unknown) => void;
      (api.runImportList as Mock).mockReturnValue(new Promise((resolve) => { settle = resolve; }));
      renderRow();

      await user.click(runButton());

      await waitFor(() => expect(runButton()).toBeDisabled());
      expect(runButton().querySelector('[data-testid="loading-spinner"]')).not.toBeNull();

      await user.click(runButton());
      expect(api.runImportList).toHaveBeenCalledTimes(1);

      settle(okCounts);
      await waitFor(() => expect(runButton()).toBeEnabled());
    });

    it.each([
      ['a 409 refusal', () => Promise.reject(new ApiError(409, { error: 'already running' }))],
      ['a genuine failure', () => Promise.reject(new Error('Network down'))],
    ])('re-enables the control after %s', async (_label, reject) => {
      const user = userEvent.setup();
      (api.runImportList as Mock).mockImplementation(reject);
      renderRow();

      await user.click(runButton());

      await waitFor(() => expect(runButton()).toBeEnabled());
    });

    it('offers an enabled Run control for a disabled list (Decision 3)', () => {
      renderRow({ ...mockList, enabled: false });

      expect(runButton()).toBeEnabled();
    });

    describe('settlement after the card unmounts', () => {
      /** Click Run, hold the response, then tear the card down before it settles. */
      async function unmountMidRun(settlement: 'resolve' | 'reject') {
        const user = userEvent.setup();
        let settle!: (value: unknown) => void;
        let fail!: (reason: unknown) => void;
        (api.runImportList as Mock).mockReturnValue(new Promise((resolve, reject) => {
          settle = resolve;
          fail = reject;
        }));
        const { unmount, invalidateQueries } = renderRow();

        await user.click(runButton());
        await waitFor(() => expect(api.runImportList).toHaveBeenCalledTimes(1));

        unmount();
        if (settlement === 'resolve') settle(okCounts);
        else fail(new Error('Network down'));

        return { invalidateQueries };
      }

      it('suppresses the success toast but still reconciles the list cache', async () => {
        const { invalidateQueries } = await unmountMidRun('resolve');

        await waitFor(() => expectListsInvalidated(invalidateQueries));
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        expect(toast.info).not.toHaveBeenCalled();
      });

      it('suppresses the error toast but still reconciles the list cache', async () => {
        const { invalidateQueries } = await unmountMidRun('reject');

        await waitFor(() => expectListsInvalidated(invalidateQueries));
        expect(toast.error).not.toHaveBeenCalled();
        expect(toast.info).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
      });
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
      expect(screen.getByLabelText('Bestseller List')).toBeInTheDocument();
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
        type: 'nyt',
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

      expect(screen.getByText('Connection OK')).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');

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

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      expect(screen.queryByText('Connection OK')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(onFormTest).toHaveBeenCalledWith(expect.objectContaining({ type: 'nyt' }));

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
        type: 'nyt',
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

      expect(screen.getByDisplayValue('My NYT List')).toBeInTheDocument();
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

    // Import-list edits use the saved-id endpoint, not test-by-config.
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

      const nameInput = screen.getByDisplayValue('My NYT List');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated List');
      await user.click(screen.getByText('Update', { selector: 'button[type="submit"]' }));

      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Updated List',
        type: 'nyt',
      }));
    });

    it('Preview Items forwards initial.id when editing an existing list', async () => {
      const user = userEvent.setup();
      (api.previewImportList as Mock).mockResolvedValue({ items: [], total: 0 });
      renderWithProviders(
        <ImportListCard list={mockList} mode="edit" onSubmit={noop} />
      );

      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => expect(api.previewImportList).toHaveBeenCalled());
      expect(api.previewImportList).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, type: 'nyt' }),
      );
    });
  });

  // Only create mode switches providers; handleTypeChange must reset to the new defaults.
  describe('#908 — ImportListCard handleTypeChange registry reset (no foreign-type leak)', () => {
    it('hardcover → nyt switch drops hardcover-only keys from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      // Populate shared apiKey so a same-key carryover mutation cannot pass vacuously.
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.type(screen.getByLabelText('API Key'), 'hc-secret-key');
      await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');
      await user.type(await screen.findByLabelText('Shelf ID'), '42');

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      await screen.findByLabelText('Bestseller List');

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalled();
      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      const foreignKeys = foreignImportListKeys('nyt');
      expect(foreignKeys).toEqual(expect.arrayContaining(['listType']));
      for (const key of foreignKeys) {
        expect(payloadSettings).not.toHaveProperty(key);
      }
      expect(payloadSettings).not.toHaveProperty('shelfId');

      expect(payloadSettings).toHaveProperty('list', 'audio-fiction');
      expect(payloadSettings).toHaveProperty('apiKey', '');
    });

    it('nyt → hardcover switch drops the nyt-only list key from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      await user.selectOptions(screen.getByLabelText('Bestseller List'), 'audio-nonfiction');

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await screen.findByLabelText('List Type');

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalled();
      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      const foreignKeys = foreignImportListKeys('hardcover');
      expect(foreignKeys).toEqual(expect.arrayContaining(['list']));
      for (const key of foreignKeys) {
        expect(payloadSettings).not.toHaveProperty(key);
      }

      expect(payloadSettings).toHaveProperty('listType', 'trending');
      expect(payloadSettings).toHaveProperty('apiKey', '');
    });

    it('hardcover shelfId minted then switched away is dropped from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(
        <ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />
      );

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');
      await user.type(await screen.findByLabelText('Shelf ID'), '42');

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      await screen.findByLabelText('Bestseller List');

      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      expect(onFormTest).toHaveBeenCalled();
      const payloadSettings = onFormTest.mock.calls[0]![0].settings as Record<string, unknown>;

      expect(payloadSettings).not.toHaveProperty('shelfId');
      expect(payloadSettings).not.toHaveProperty('listType');
      expect(payloadSettings).toHaveProperty('list', 'audio-fiction');
    });
  });

  describe('#1879 — Hardcover list-type change scrubs foreign keys', () => {
    const CUSTOM_URL = 'https://hardcover.app/@LisaRae/lists/2025-year-in-books';

    it('custom → trending drops listUrl/importMax from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(<ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />);

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.selectOptions(screen.getByLabelText('List Type'), 'custom');
      await user.type(await screen.findByLabelText('List URL'), CUSTOM_URL);
      await user.selectOptions(screen.getByLabelText('Import Max'), '100');

      await user.selectOptions(screen.getByLabelText('List Type'), 'trending');
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      const payloadSettings = onFormTest.mock.calls.at(-1)![0].settings as Record<string, unknown>;
      expect(payloadSettings).not.toHaveProperty('listUrl');
      expect(payloadSettings).not.toHaveProperty('importMax');
      expect(payloadSettings).toMatchObject({ listType: 'trending' });
    });

    it('shelf → custom drops shelfId from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(<ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />);

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');
      await user.type(await screen.findByLabelText('Shelf ID'), '42');

      await user.selectOptions(screen.getByLabelText('List Type'), 'custom');
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      const payloadSettings = onFormTest.mock.calls.at(-1)![0].settings as Record<string, unknown>;
      expect(payloadSettings).not.toHaveProperty('shelfId');
      expect(payloadSettings).toMatchObject({ listType: 'custom' });
    });

    // Populate listUrl/importMax first so the scrub assertion is non-vacuous.
    it('custom → shelf drops the minted listUrl/importMax from the Test payload', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(<ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />);

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.selectOptions(screen.getByLabelText('List Type'), 'custom');
      await user.type(await screen.findByLabelText('List URL'), CUSTOM_URL);
      await user.selectOptions(screen.getByLabelText('Import Max'), '100');

      await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');
      await screen.findByLabelText('Shelf ID');
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      const payloadSettings = onFormTest.mock.calls.at(-1)![0].settings as Record<string, unknown>;
      expect(payloadSettings).not.toHaveProperty('listUrl');
      expect(payloadSettings).not.toHaveProperty('importMax');
      expect(payloadSettings).toMatchObject({ listType: 'shelf' });
    });

    // Populated custom keys cover the dynamic-key gap in registry-derived checks.
    it('provider switch away from a populated custom list drops listUrl/importMax (and listType)', async () => {
      const user = userEvent.setup();
      const onFormTest = vi.fn();
      renderWithProviders(<ImportListCard mode="create" onSubmit={noop} onFormTest={onFormTest} />);

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');
      await user.selectOptions(screen.getByLabelText('List Type'), 'custom');
      await user.type(await screen.findByLabelText('List URL'), CUSTOM_URL);
      await user.selectOptions(screen.getByLabelText('Import Max'), 'all');

      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');
      await screen.findByLabelText('Bestseller List');
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      const payloadSettings = onFormTest.mock.calls.at(-1)![0].settings as Record<string, unknown>;
      expect(payloadSettings).not.toHaveProperty('listUrl');
      expect(payloadSettings).not.toHaveProperty('importMax');
      expect(payloadSettings).not.toHaveProperty('listType');
      expect(payloadSettings).toMatchObject({ list: 'audio-fiction' });
    });
  });
});
