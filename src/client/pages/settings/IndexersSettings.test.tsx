import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
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
    const newIndexer = { id: 3, name: 'New Indexer', type: 'newznab', enabled: true, priority: 50, settings: { apiUrl: 'https://example.com/api', apiKey: 'key123' }, createdAt: '2024-01-01T00:00:00Z' };
    (api.createIndexer as Mock).mockResolvedValue(newIndexer);
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('Newznab'), 'New Indexer');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'https://example.com/api');
    await user.type(screen.getByLabelText('API Key'), 'key123');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(api.createIndexer).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect((api.createIndexer as Mock).mock.calls[0]![0]).toMatchObject({
        name: 'New Indexer',
        type: 'newznab',
        settings: expect.objectContaining({ apiUrl: 'https://example.com/api' }),
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
    await user.type(screen.getByPlaceholderText('Newznab'), 'Fail');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'https://example.com/api');
    await user.type(screen.getByLabelText('API Key'), 'key123');
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
      const [id, data] = (api.updateIndexer as Mock).mock.calls[0]!;
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
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'https://example.com/api');
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
    await user.type(screen.getByPlaceholderText('Newznab'), 'Test');
    await user.click(screen.getByText('Add Indexer', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(screen.getByText('API URL is required')).toBeInTheDocument();
      expect(api.createIndexer).not.toHaveBeenCalled();
    });
  });

  it('tests an existing indexer via the test button', async () => {
    const user = userEvent.setup();
    (api.testIndexer as Mock).mockResolvedValue({ success: true, message: 'OK' });
    renderWithProviders(<IndexersSettings />);
    await waitForListLoad('My ABB');

    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]!);

    await waitFor(() => {
      expect(api.testIndexer).toHaveBeenCalledWith(1);
    });
  });

  describe('#1057 — end-to-end testByConfig payload (centralized id injection)', () => {
    function modalContainer(): HTMLElement {
      const backdrop = screen.getByTestId('modal-backdrop');
      return backdrop.closest('.fixed.inset-0') as HTMLElement;
    }

    it('edit-mode Test routes through useCrudSettings → useConnectionTest and posts id to testIndexerConfig', async () => {
      const user = userEvent.setup();
      (api.testIndexerConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });
      renderWithProviders(<IndexersSettings />);
      await waitForListLoad('My ABB');

      // Open edit modal for indexer id 1
      await user.click(screen.getByLabelText('Edit My ABB'));
      await waitFor(() => {
        expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
      });

      // Click the form-test button inside the modal (not the in-list view-mode test)
      await user.click(within(modalContainer()).getByRole('button', { name: /^test$/i }));

      await waitFor(() => {
        expect(api.testIndexerConfig).toHaveBeenCalled();
      });
      const payload = (api.testIndexerConfig as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(payload).toMatchObject({ id: 1 });
    });

    it('create-mode Test posts no id key to testIndexerConfig (centralization preserves opt-out for create)', async () => {
      const user = userEvent.setup();
      (api.testIndexerConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });
      renderWithProviders(<IndexersSettings />);
      await waitForListLoad('My ABB');

      await user.click(screen.getByRole('button', { name: 'Add Indexer' }));
      await user.type(screen.getByPlaceholderText('Newznab'), 'Brand New');
      await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'https://x.example.com/api');
      await user.type(screen.getByLabelText('API Key'), 'k');

      await user.click(within(modalContainer()).getByRole('button', { name: /^test$/i }));

      await waitFor(() => {
        expect(api.testIndexerConfig).toHaveBeenCalled();
      });
      const payload = (api.testIndexerConfig as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('id');
    });
  });

  describe('#1065 — deep link via ?edit=<id>', () => {
    it('opens edit modal automatically when route has ?edit=<existing-id>', async () => {
      renderWithProviders(<IndexersSettings />, { route: '/settings/indexers?edit=1' });

      await waitFor(() => {
        expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('AudioBookBay')).toHaveValue('My ABB');
    });

    it('does not open modal when ?edit references a missing id', async () => {
      renderWithProviders(<IndexersSettings />, { route: '/settings/indexers?edit=999' });

      await waitForListLoad('My ABB');
      expect(screen.queryByText('Edit Indexer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('modal-backdrop')).toBeNull();
    });

    it('ignores malformed ?edit value (non-numeric) without crashing', async () => {
      renderWithProviders(<IndexersSettings />, { route: '/settings/indexers?edit=abc' });

      await waitForListLoad('My ABB');
      expect(screen.queryByText('Edit Indexer')).not.toBeInTheDocument();
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
      await user.click(editButtons[0]!);

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    });

    it('backdrop click does not close modal and preserves filled field value', async () => {
      const user = userEvent.setup();
      renderWithProviders(<IndexersSettings />);
      await waitForListLoad('My ABB');

      await user.click(screen.getByRole('button', { name: 'Add Indexer' }));
      const nameInput = screen.getByPlaceholderText('Newznab');
      await user.type(nameInput, 'Draft Indexer');

      fireEvent.click(screen.getByTestId('modal-backdrop'));

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Newznab')).toHaveValue('Draft Indexer');
    });
  });
});
