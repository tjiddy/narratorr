import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportListsSettings } from './ImportListsSettings';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getImportLists: vi.fn(),
    createImportList: vi.fn(),
    updateImportList: vi.fn(),
    deleteImportList: vi.fn(),
    testImportListConfig: vi.fn(),
    testImportList: vi.fn(),
    previewImportList: vi.fn(),
    fetchAbsLibraries: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockList = {
  id: 1,
  name: 'My ABS List',
  type: 'abs' as const,
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { serverUrl: 'http://abs.local', apiKey: '***', libraryId: 'lib-1' },
  lastRunAt: null,
  nextRunAt: null,
  lastSyncError: null,
  createdAt: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getImportLists as Mock).mockResolvedValue([mockList]);
});

describe('ImportListsSettings', () => {
  it('renders empty state when no lists configured', async () => {
    (api.getImportLists as Mock).mockResolvedValue([]);
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No import lists configured')).toBeInTheDocument();
    });
  });

  it('renders list of import lists', async () => {
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });
    expect(screen.getByText(/Audiobookshelf/)).toBeInTheDocument();
    expect(screen.getByText(/every 1440m/)).toBeInTheDocument();
  });

  it('shows ABS-specific fields by default when adding', async () => {
    (api.getImportLists as Mock).mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No import lists configured')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Import List').closest('button')!);

    // ABS fields: Server URL, API Key, Library
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Library')).toBeInTheDocument();
  });

  it('switches to NYT fields when type changes', async () => {
    (api.getImportLists as Mock).mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No import lists configured')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Import List').closest('button')!);

    // Switch to NYT
    const typeSelect = screen.getByLabelText('Provider Type');
    await user.selectOptions(typeSelect, 'nyt');

    // NYT fields: API Key + Bestseller List dropdown
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Bestseller List')).toBeInTheDocument();
    // ABS-specific fields gone
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Library')).not.toBeInTheDocument();
  });

  it('shows Hardcover shelf ID field when listType is shelf', async () => {
    (api.getImportLists as Mock).mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No import lists configured')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Import List').closest('button')!);
    await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');

    // Default listType is trending — no shelf ID field
    expect(screen.queryByLabelText('Shelf ID')).not.toBeInTheDocument();

    // Switch to shelf
    await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');
    expect(screen.getByLabelText('Shelf ID')).toBeInTheDocument();
  });

  it('enable/disable toggle calls API', async () => {
    const user = userEvent.setup();
    (api.updateImportList as Mock).mockResolvedValue({ ...mockList, enabled: false });
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    const listCard = screen.getByText('My ABS List').closest('.glass-card')!;
    const buttons = listCard.querySelectorAll('button');
    await user.click(buttons[0]!);

    await waitFor(() => {
      expect(api.updateImportList).toHaveBeenCalledWith(1, { enabled: false });
    });
  });

  it('creates a new import list via the add form', async () => {
    const user = userEvent.setup();
    (api.createImportList as Mock).mockResolvedValue({ id: 2, name: 'New List', type: 'abs' });
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Import List').closest('button')!);

    // Clear default name and type new one
    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'New List');

    const submitButton = screen.getByText('Add Import List', { selector: 'button[type="submit"]' });
    await user.click(submitButton);

    await waitFor(() => {
      expect(api.createImportList).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Import list added successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createImportList as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Import List').closest('button')!);

    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Fail List');

    await user.click(screen.getByText('Add Import List', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add import list');
    });
  });

  it('switches to edit mode when edit button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('My ABS List')).toBeInTheDocument();
    });
  });

  it('delete button shows confirmation modal and deletes', async () => {
    const user = userEvent.setup();
    (api.deleteImportList as Mock).mockResolvedValue({});
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    const listCard = screen.getByText('My ABS List').closest('.glass-card')!;
    const buttons = listCard.querySelectorAll('button');
    const trashButton = buttons[buttons.length - 1];
    await user.click(trashButton!);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    // CrudSettingsPage uses deleteTitle + name in message
    expect(screen.getByText('Delete Import List')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect((api.deleteImportList as Mock).mock.calls[0]![0]).toBe(1);
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Import list removed successfully');
    });
  });

  it('shows error toast when toggle fails', async () => {
    const user = userEvent.setup();
    (api.updateImportList as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    const listCard = screen.getByText('My ABS List').closest('.glass-card')!;
    const buttons = listCard.querySelectorAll('button');
    await user.click(buttons[0]!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to toggle import list');
    });
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.deleteImportList as Mock).mockRejectedValue(new Error('fail'));
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    const listCard = screen.getByText('My ABS List').closest('.glass-card')!;
    const buttons = listCard.querySelectorAll('button');
    await user.click(buttons[buttons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete import list');
    });
  });

  it('cancel button dismisses delete modal without deleting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('My ABS List')).toBeInTheDocument();
    });

    const listCard = screen.getByText('My ABS List').closest('.glass-card')!;
    const buttons = listCard.querySelectorAll('button');
    await user.click(buttons[buttons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(api.deleteImportList).not.toHaveBeenCalled();
  });

  it('shows last sync error when present', async () => {
    (api.getImportLists as Mock).mockResolvedValue([
      { ...mockList, lastSyncError: 'Connection refused' },
    ]);
    renderWithProviders(<ImportListsSettings />);

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });

  describe('test connection', () => {
    it('shows success result when test passes', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.testImportListConfig as Mock).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      await waitFor(() => {
        expect(screen.getByText('Connection OK')).toBeInTheDocument();
      });
    });

    it('shows error result when test fails', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.testImportListConfig as Mock).mockResolvedValue({ success: false, message: 'Invalid API key' });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid API key')).toBeInTheDocument();
      });
    });
  });

  describe('preview items', () => {
    it('shows preview results when clicked', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.previewImportList as Mock).mockResolvedValue({
        items: [{ title: 'Book One', author: 'Author A' }],
        total: 5,
      });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => {
        expect(screen.getByText('Book One')).toBeInTheDocument();
      });
      expect(screen.getByText(/by Author A/)).toBeInTheDocument();
      expect(screen.getByText('Showing 1 of 5 items')).toBeInTheDocument();
    });

    it('renders true duplicate preview items without React duplicate-key warning', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.previewImportList as Mock).mockResolvedValue({
        items: [
          { title: 'Same Book', author: 'Same Author' },
          { title: 'Same Book', author: 'Same Author' },
        ],
        total: 2,
      });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => {
        expect(screen.getByText('Showing 2 of 2 items')).toBeInTheDocument();
      });

      expect(screen.getAllByText('Same Book')).toHaveLength(2);
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything(), expect.anything());
      spy.mockRestore();
    });

    it('shows toast when preview fails', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.previewImportList as Mock).mockRejectedValue(new Error('fail'));
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.click(screen.getByRole('button', { name: /Preview Items/ }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Preview failed — check your settings');
      });
    });
  });

  describe('ABS library fetching', () => {
    it('populates library dropdown after fetch', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.fetchAbsLibraries as Mock).mockResolvedValue({
        libraries: [
          { id: 'lib-1', name: 'Audiobooks' },
          { id: 'lib-2', name: 'Podcasts' },
        ],
      });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);

      // Fill server URL and API key
      await user.type(screen.getByLabelText('Server URL'), 'http://abs.local');
      await user.type(screen.getByLabelText('API Key'), 'test-key');

      // Fetch libraries
      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByText('Audiobooks')).toBeInTheDocument();
      });
      expect(screen.getByText('Podcasts')).toBeInTheDocument();
    });

    it('shows error when fetch fails', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.fetchAbsLibraries as Mock).mockRejectedValue(new Error('fail'));
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.type(screen.getByLabelText('Server URL'), 'http://abs.local');
      await user.type(screen.getByLabelText('API Key'), 'test-key');
      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByText('Failed to fetch libraries')).toBeInTheDocument();
      });
    });
  });

  describe('add form cancel button', () => {
    it('add form shows Cancel button in bottom row', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('clicking Cancel in add form closes the form', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      expect(screen.getByLabelText('Name')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    });

    it('header Add button remains enabled while modal is open (intentional change)', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      const headerButton = screen.getByText('Add Import List').closest('button')!;
      expect(headerButton).not.toBeDisabled();

      await user.click(headerButton);

      // In modal mode, header button stays enabled (aligns with CrudSettingsPage shared behavior)
      const headerButtons = screen.getAllByText('Add Import List');
      const headerBtn = headerButtons.find(el => el.closest('button')?.getAttribute('type') !== 'submit')?.closest('button');
      expect(headerBtn).not.toBeDisabled();
    });

    it('Cancel button is blocked while create mutation is pending (intentional change)', async () => {
      (api.getImportLists as Mock).mockResolvedValue([mockList]);
      // Never-resolving promise keeps mutation in pending state
      (api.createImportList as Mock).mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('My ABS List')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);

      // Fill name (clear default, type new) and submit to enter pending state
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Pending List');
      await user.click(screen.getByText('Add Import List', { selector: 'button[type="submit"]' }));

      // Verify mutation was called and submit button shows pending state
      await waitFor(() => {
        expect(api.createImportList).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText('Saving...')).toBeInTheDocument();
      });

      // Cancel button click should NOT close modal while pending (shared modal contract)
      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      await user.click(cancelButton);

      // Form should still be open (modal blocked close during pending)
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });
  });

  describe('modal rendering', () => {
    it('clicking Add opens form in a modal overlay', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });

    it('clicking edit opens form in modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('My ABS List')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Edit'));

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
      expect(screen.getByDisplayValue('My ABS List')).toBeInTheDocument();
    });

    it('pressing Escape closes the modal when no mutation pending', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

      await waitFor(() => {
        expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument();
      });
    });

    it('pressing Escape does NOT close modal while create mutation is pending', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.createImportList as Mock).mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);

      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Pending List');
      await user.click(screen.getByText('Add Import List', { selector: 'button[type="submit"]' }));

      await waitFor(() => {
        expect(api.createImportList).toHaveBeenCalled();
      });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
    });
  });

  describe('intentional behavior changes', () => {
    it('Cancel button closes modal when no mutation is pending', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await waitFor(() => {
        expect(screen.getByText('No import lists configured')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Add Import List').closest('button')!);
      expect(screen.getByLabelText('Name')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument();
      });
    });
  });

  describe('useCrudSettings alignment', () => {
    it('cancel button in edit modal clears edit mode', async () => {
      (api.getImportLists as Mock).mockResolvedValue([mockList]);
      const user = userEvent.setup();

      renderWithProviders(<ImportListsSettings />);

      // Enter edit mode (opens modal)
      await user.click(await screen.findByText('Edit'));
      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();

      // Cancel editing via Cancel button in modal form
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      // Modal should close and view mode restored
      await waitFor(() => {
        expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('toast shows entity name on create success', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.createImportList as Mock).mockResolvedValue(mockList);
      const user = userEvent.setup();

      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.type(screen.getByLabelText('Name'), 'Test List');
      await user.type(screen.getByLabelText('Server URL'), 'http://abs.local');
      await user.type(screen.getByLabelText('API Key'), 'key');

      await user.click(screen.getByText('Add Import List', { selector: 'button[type="submit"]' }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Import list added successfully');
      });
    });
  });

  describe('a11y label pairing', () => {
    it('Enabled checkbox input has id="il-enabled"', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('id', 'il-enabled');
    });

    it('Enabled checkbox label has htmlFor="il-enabled"', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);

      // Form is portaled to body in modal mode, so use document.querySelector
      const label = document.querySelector('label[for="il-enabled"]');
      expect(label).not.toBeNull();
      expect(label!.textContent).toContain('Enabled');
    });

    it('provider type select uses shared SelectWithChevron contract', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);

      const typeSelect = screen.getByLabelText('Provider Type');
      expect(typeSelect).toHaveClass('appearance-none');
      expect(typeSelect.parentElement!.querySelector('svg')).toBeInTheDocument();
    });

    it('NYT bestseller list select uses shared SelectWithChevron contract', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'nyt');

      const listSelect = screen.getByLabelText('Bestseller List');
      expect(listSelect).toHaveClass('appearance-none');
      expect(listSelect.parentElement!.querySelector('svg')).toBeInTheDocument();
    });

    it('Hardcover list type select uses shared SelectWithChevron contract', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);
      await user.selectOptions(screen.getByLabelText('Provider Type'), 'hardcover');

      const listTypeSelect = screen.getByLabelText('List Type');
      expect(listTypeSelect).toHaveClass('appearance-none');
      expect(listTypeSelect.parentElement!.querySelector('svg')).toBeInTheDocument();
    });

    it('ABS library select uses shared SelectWithChevron contract after fetch', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      (api.fetchAbsLibraries as Mock).mockResolvedValue({
        libraries: [
          { id: 'lib1', name: 'Audiobooks' },
          { id: 'lib2', name: 'Podcasts' },
        ],
      });
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);

      // Fill required fields to enable Fetch
      await user.type(screen.getByLabelText('Server URL'), 'http://abs.local');
      await user.type(screen.getByLabelText('API Key'), 'test-key');
      await user.click(screen.getByRole('button', { name: /fetch libraries/i }));

      await waitFor(() => {
        const librarySelect = screen.getByLabelText('Library');
        expect(librarySelect.tagName).toBe('SELECT');
      });

      const librarySelect = screen.getByLabelText('Library') as HTMLSelectElement;
      expect(librarySelect).toHaveClass('appearance-none');
      expect(librarySelect.parentElement!.querySelector('svg')).toBeInTheDocument();
      expect(librarySelect.querySelectorAll('option')).toHaveLength(3); // placeholder + 2 libs

      // Verify selecting an option updates the value through the onChange handler
      await user.selectOptions(librarySelect, 'lib1');
      expect(librarySelect.value).toBe('lib1');
    });

    it('existing labels (il-name, il-type, il-syncInterval) remain accessible via getByLabelText', async () => {
      (api.getImportLists as Mock).mockResolvedValue([]);
      const user = userEvent.setup();
      renderWithProviders(<ImportListsSettings />);

      await screen.findByText('No import lists configured');
      await user.click(screen.getByText('Add Import List').closest('button')!);

      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Provider Type')).toBeInTheDocument();
      expect(screen.getByLabelText('Sync Interval (minutes)')).toBeInTheDocument();
    });
  });
});
