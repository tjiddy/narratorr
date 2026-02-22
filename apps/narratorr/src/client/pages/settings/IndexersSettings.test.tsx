import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockIndexer } from '@/__tests__/factories';
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
import { toast } from 'sonner';

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
    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });
    expect(screen.getByText('My Torznab')).toBeInTheDocument();
  });

  it('shows empty state when no indexers exist', async () => {
    (api.getIndexers as Mock).mockResolvedValue([]);
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('No indexers configured')).toBeInTheDocument();
    });
  });

  it('toggles add form when Add Indexer button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    // Use closest('button') because button text is in a hidden sm:inline span
    const addButton = screen.getByText('Add Indexer').closest('button')!;
    await user.click(addButton);

    expect(screen.getByText('Add New Indexer')).toBeInTheDocument();

    // Click again to cancel
    const cancelButton = screen.getByText('Cancel').closest('button')!;
    await user.click(cancelButton);

    expect(screen.queryByText('Add New Indexer')).not.toBeInTheDocument();
  });

  it('opens Prowlarr import modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    const prowlarrButton = screen.getByText('Prowlarr').closest('button')!;
    await user.click(prowlarrButton);

    // ProwlarrImport renders when isOpen is true
    expect(screen.getByText('Import from Prowlarr')).toBeInTheDocument();
  });

  it('creates a new indexer via the add form', async () => {
    const user = userEvent.setup();
    const newIndexer = { id: 3, name: 'New Indexer', type: 'abb', enabled: true, priority: 50, settings: { hostname: 'example.com', pageLimit: 2 }, createdAt: '2024-01-01T00:00:00Z' };
    (api.createIndexer as Mock).mockResolvedValue(newIndexer);
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'New Indexer');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    // Submit button says "Add Indexer" — but it's a submit button, distinct from the toggle button
    const submitButton = screen.getByRole('button', { name: /Add Indexer/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(api.createIndexer).toHaveBeenCalled();
    });
    expect((api.createIndexer as Mock).mock.calls[0][0]).toMatchObject({
      name: 'New Indexer',
      type: 'abb',
      settings: expect.objectContaining({ hostname: 'example.com' }),
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Indexer added successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createIndexer as Mock).mockRejectedValue(new Error('Server error'));
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Fail');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    const submitButton = screen.getByRole('button', { name: /Add Indexer/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add indexer');
    });
  });

  it('switches to edit mode when edit button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Edit My ABB'));

    expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('AudioBookBay')).toHaveValue('My ABB');
  });

  it('updates an existing indexer', async () => {
    const user = userEvent.setup();
    (api.updateIndexer as Mock).mockResolvedValue({ ...mockIndexers[0], name: 'Updated ABB' });
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Edit My ABB'));
    const nameInput = screen.getByPlaceholderText('AudioBookBay');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated ABB');
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(api.updateIndexer).toHaveBeenCalled();
    });
    const [id, data] = (api.updateIndexer as Mock).mock.calls[0];
    expect(id).toBe(1);
    expect(data).toMatchObject({ name: 'Updated ABB' });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Indexer updated');
    });
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.updateIndexer as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Edit My ABB'));
    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update indexer');
    });
  });

  it('opens delete confirmation modal and deletes indexer', async () => {
    const user = userEvent.setup();
    (api.deleteIndexer as Mock).mockResolvedValue({});
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My ABB'));

    // Confirm modal should appear
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete "My ABB"/)).toBeInTheDocument();

    // Click the Delete button inside the modal
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Delete',
    )!;
    await user.click(confirmButton);

    await waitFor(() => {
      expect((api.deleteIndexer as Mock).mock.calls[0][0]).toBe(1);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Indexer removed successfully');
    });
  });

  it('cancels delete confirmation modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My ABB'));
    expect(screen.getByText('Delete Indexer')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Delete Indexer')).not.toBeInTheDocument();
    expect(api.deleteIndexer).not.toHaveBeenCalled();
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteIndexer as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Delete My ABB'));

    const dialog = screen.getByRole('dialog');
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Delete',
    )!;
    await user.click(confirmButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete indexer');
    });
  });

  it('shows validation errors when submitting empty name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    // Fill hostname but leave name empty
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByRole('button', { name: /Add Indexer/i }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
    expect(api.createIndexer).not.toHaveBeenCalled();
  });

  it('shows validation errors when submitting empty required settings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Indexer').closest('button')!);
    // Fill name but leave hostname empty (abb type requires hostname)
    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Test');
    await user.click(screen.getByRole('button', { name: /Add Indexer/i }));

    await waitFor(() => {
      expect(screen.getByText('Hostname is required')).toBeInTheDocument();
    });
    expect(api.createIndexer).not.toHaveBeenCalled();
  });

  it('tests an existing indexer via the test button', async () => {
    const user = userEvent.setup();
    (api.testIndexer as Mock).mockResolvedValue({ success: true, message: 'OK' });
    renderWithProviders(<IndexersSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABB')).toBeInTheDocument();
    });

    // Test buttons are rendered per card — click the first one
    const testButtons = screen.getAllByText('Test').map((el) => el.closest('button')!);
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(api.testIndexer).toHaveBeenCalledWith(1);
    });
  });
});
