import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockIndexer } from '@/__tests__/factories';
import {
  waitForListLoad,
  assertDeleteFlow,
  assertCancelDelete,
  assertDeleteError,
  assertToggleAddForm,
  assertSuccessToast,
  assertErrorToast,
} from '@/__tests__/crud-settings-helpers';
import { IndexersSettings } from './IndexersSettings';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getIndexers: vi.fn(),
    createIndexer: vi.fn(),
    updateIndexer: vi.fn(),
    deleteIndexer: vi.fn(),
    testIndexer: vi.fn(),
    testIndexerConfig: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';

const mockIndexers = [
  createMockIndexer({ id: 1 }),
  createMockIndexer({
    id: 2,
    name: 'My Torznab',
    type: 'torznab',
    enabled: false,
    priority: 30,
    settings: { apiUrl: 'https://indexer.example.com/api', apiKey: 'secret' },
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.getIndexers as Mock).mockResolvedValue(mockIndexers);
});

describe('IndexersSettings', () => {
  it('renders header and indexer list', async () => {
    renderWithProviders(<IndexersSettings />);

    expect(screen.getByText('Indexers')).toBeInTheDocument();
    await waitForListLoad('My ABB');
    await waitFor(() => {
      expect(screen.getByText('My Torznab')).toBeInTheDocument();
    });
  });

  it('shows empty state when no indexers exist', async () => {
    (api.getIndexers as Mock).mockResolvedValue([]);
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('No indexers configured')).toBeInTheDocument();
    });
  });

  it('does not render the Prowlarr import button or modal', async () => {
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    expect(screen.queryByRole('button', { name: /prowlarr/i })).toBeNull();
    expect(screen.queryByText('Import from Prowlarr')).toBeNull();
  });

  it('toggles add form when Add Indexer button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await assertToggleAddForm(user, 'Add Indexer', 'Add New Indexer');
  });


  it('creates a new indexer via the add form', async () => {
    const user = userEvent.setup();
    const newIndexer = { id: 3, name: 'New Indexer', type: 'abb', enabled: true, priority: 50, settings: { hostname: 'example.com', pageLimit: 2 }, createdAt: '2024-01-01T00:00:00Z' };
    (api.createIndexer as Mock).mockResolvedValue(newIndexer);
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'New Indexer');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(api.createIndexer).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect((api.createIndexer as Mock).mock.calls[0][0]).toMatchObject({
        name: 'New Indexer',
        type: 'abb',
        settings: expect.objectContaining({ hostname: 'example.com' }),
      });
    });

    await assertSuccessToast('Indexer added successfully');
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createIndexer as Mock).mockRejectedValue(new Error('Server error'));
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Fail');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await assertErrorToast('Failed to add indexer');
  });

  it('switches to edit mode when edit button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByLabelText('Edit My ABB'));
    await waitFor(() => {
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('AudioBookBay')).toHaveValue('My ABB');
    });
  });

  it('updates an existing indexer', async () => {
    const user = userEvent.setup();
    (api.updateIndexer as Mock).mockResolvedValue({ ...mockIndexers[0], name: 'Updated ABB' });
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByLabelText('Edit My ABB'));
    const nameInput = screen.getByPlaceholderText('AudioBookBay');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated ABB');
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateIndexer).toHaveBeenCalled();
    });
    await waitFor(() => {
      const [id, data] = (api.updateIndexer as Mock).mock.calls[0];
      expect(id).toBe(1);
      expect(data).toMatchObject({ name: 'Updated ABB' });
    });

    await assertSuccessToast('Indexer updated');
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.updateIndexer as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByLabelText('Edit My ABB'));
    await user.click(screen.getByText('Save Changes'));

    await assertErrorToast('Failed to update indexer');
  });

  it('opens delete confirmation modal and deletes indexer', async () => {
    const user = userEvent.setup();
    (api.deleteIndexer as Mock).mockResolvedValue({});
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await assertDeleteFlow(user, 'My ABB', api.deleteIndexer as Mock, 1, 'Indexer');
  });

  it('cancels delete confirmation modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await assertCancelDelete(user, 'My ABB', api.deleteIndexer as Mock);
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteIndexer as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await assertDeleteError(user, 'My ABB', 'Indexer');
  });

  it('shows validation errors when submitting empty name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
      expect(api.createIndexer).not.toHaveBeenCalled();
    });
  });

  it('shows validation errors when submitting empty required settings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Test');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(screen.getByText('Hostname is required')).toBeInTheDocument();
      expect(api.createIndexer).not.toHaveBeenCalled();
    });
  });

  it('tests an existing indexer via the test button', async () => {
    const user = userEvent.setup();
    (api.testIndexer as Mock).mockResolvedValue({ success: true, message: 'OK' });
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(api.testIndexer).toHaveBeenCalledWith(1);
    });
  });

  describe('modal mode', () => {
    it('clicking Add Indexer opens the create form inside a modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<IndexersSettings />);
      await waitForListLoad('My ABB');

      await user.click(screen.getByRole('button', { name: 'Add Indexer' }));

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    });

    it('clicking Edit on an indexer card opens the edit form inside a modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<IndexersSettings />);
      await waitForListLoad('My ABB');

      const editButtons = screen.getAllByText('Edit').map((el) => el.closest('button')!);
      await user.click(editButtons[0]);

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    });
  });
});
