import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ProwlarrImport } from './ProwlarrImport';
import type { SyncPreviewItem } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    testConnection: vi.fn(),
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    preview: vi.fn(),
    sync: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockPreviewItems: SyncPreviewItem[] = [
  { prowlarrId: 1, name: 'MyAnonaMouse', type: 'torznab', action: 'new' },
  { prowlarrId: 2, name: 'NZBgeek', type: 'newznab', action: 'updated', changes: ['name'] },
  { prowlarrId: 3, name: 'Existing', type: 'torznab', action: 'unchanged' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getConfig).mockRejectedValue(new Error('Not configured'));
});

describe('ProwlarrImport', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <ProwlarrImport isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders form fields and header when open', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Import from Prowlarr')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('http://localhost:9696')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your Prowlarr API key')).toBeInTheDocument();
    expect(screen.getByText('Add Only')).toBeInTheDocument();
    expect(screen.getByText('Full Sync')).toBeInTheDocument();
  });

  it('test button calls testConnection with url and apiKey', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'test-key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(api.testConnection).toHaveBeenCalledWith('http://prowlarr:9696', 'test-key');
      expect(toast.success).toHaveBeenCalledWith('Connected to Prowlarr');
    });
  });

  it('shows error toast on failed test', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: false, message: 'Refused' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://bad:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection failed: Refused');
    });
  });

  it('next button is disabled until test passes', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('next button is enabled after successful test', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Next')).not.toBeDisabled();
    });
  });

  it('changing URL resets test state and disables next', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Next')).not.toBeDisabled();
    });

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), '/v2');

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('clicking next saves config and shows preview table', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(api.saveConfig).toHaveBeenCalled();
      expect(api.preview).toHaveBeenCalled();
      expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument();
      expect(screen.getByText('NZBgeek')).toBeInTheDocument();
    });

    expect(screen.getByText('Select indexers to import')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('checkboxes default to selected for non-unchanged items', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it('import selected sends items and closes on success', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockResolvedValue({ added: 1, updated: 1, removed: 0 });
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={onClose} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(api.sync).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Sync complete: 1 added, 1 updated');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('back button returns to connect step', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Back'));

    expect(screen.getByPlaceholderText('http://localhost:9696')).toBeInTheDocument();
    expect(screen.queryByText('MyAnonaMouse')).not.toBeInTheDocument();
  });

  it('close button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={onClose} />);

    await user.click(screen.getByLabelText('Close modal'));

    expect(onClose).toHaveBeenCalled();
  });

  it('sync mode toggles between addOnly and fullSync', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    const fullSyncBtn = screen.getByText('Full Sync');
    await user.click(fullSyncBtn);

    expect(screen.getByText('Add, update, and remove to match Prowlarr')).toBeInTheDocument();

    const addOnlyBtn = screen.getByText('Add Only');
    await user.click(addOnlyBtn);

    expect(screen.getByText('Only import new indexers')).toBeInTheDocument();
  });

  it('clicking backdrop calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={onClose} />);

    const backdrop = screen.getByText('Import from Prowlarr').closest('.fixed') as HTMLElement;
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('shows error toast when sync fails', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockRejectedValue(new Error('Database locked'));
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Sync failed: Database locked');
    });
  });

  it('disables import button while sync is pending', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    // Never resolve so sync stays pending
    vi.mocked(api.sync).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    // Button should now be disabled (isPending)
    await waitFor(() => {
      expect(screen.getByText('Import Selected').closest('button')).toBeDisabled();
    });
  });

  it('shows error toast when testConnection throws (network error)', async () => {
    vi.mocked(api.testConnection).mockRejectedValue(new Error('Network Error'));
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://bad:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection failed: Network Error');
    });
  });

  it('shows error toast when testConnection fails with non-Error object', async () => {
    vi.mocked(api.testConnection).mockRejectedValue('string error');
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://bad:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection failed: Unknown error');
    });
  });

  it('shows error toast and returns to connect step when preview fails', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Preview failed: Save failed');
    });

    // Should be back on the connect step
    expect(screen.getByPlaceholderText('http://localhost:9696')).toBeInTheDocument();
  });

  it('shows empty state when preview returns no items', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText('No indexers found matching your categories.')).toBeInTheDocument();
    });
  });

  it('shows removals warning when items have removed action', async () => {
    const itemsWithRemoval: SyncPreviewItem[] = [
      { prowlarrId: 1, name: 'NewIndexer', type: 'torznab', action: 'new' },
      { prowlarrId: 2, name: 'OldIndexer', type: 'newznab', action: 'removed' },
    ];
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'fullSync', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(itemsWithRemoval);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText('Removals are destructive')).toBeInTheDocument();
      expect(screen.getByText('Removed')).toBeInTheDocument();
    });
  });

  it('unchecking all items disables Import Selected button', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    // Uncheck both non-unchanged items
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    expect(screen.getByText('Import Selected').closest('button')).toBeDisabled();
  });

  it('shows "No changes applied" toast when sync returns all zeros', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockResolvedValue({ added: 0, updated: 0, removed: 0 });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('No changes applied');
    });
  });

  it('pre-populates form fields from existing config', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      url: 'http://saved:9696',
      apiKey: 'saved-key',
      syncMode: 'fullSync',
      categories: [3030, 3040],
    });

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('http://localhost:9696')).toHaveValue('http://saved:9696');
    });

    expect(screen.getByPlaceholderText('Your Prowlarr API key')).toHaveValue('saved-key');
    expect(screen.getByPlaceholderText('3030')).toHaveValue('3030, 3040');
    expect(screen.getByText('Add, update, and remove to match Prowlarr')).toBeInTheDocument();
  });

  it('changing API key resets test state', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Next')).not.toBeDisabled();
    });

    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), '2');

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('test and next buttons are disabled when URL is empty', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Test').closest('button')).toBeDisabled();
    expect(screen.getByText('Next').closest('button')).toBeDisabled();
  });

  it('test and next buttons are disabled when API key is empty', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');

    expect(screen.getByText('Test').closest('button')).toBeDisabled();
    expect(screen.getByText('Next').closest('button')).toBeDisabled();
  });

  it('saves config with correctly parsed categories', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030, 3040],
    });
    vi.mocked(api.preview).mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');

    // Clear default categories and type new ones
    const categoriesInput = screen.getByPlaceholderText('3030');
    await user.clear(categoriesInput);
    await user.type(categoriesInput, '3030, 3040, invalid');

    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(api.saveConfig).toHaveBeenCalledWith({
        url: 'http://prowlarr:9696',
        apiKey: 'key',
        syncMode: 'addOnly',
        categories: [3030, 3040],
      });
    });
  });

  it('strips trailing slashes from URL when saving config', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696///');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(api.saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://prowlarr:9696' }),
      );
    });
  });

  it('has correct ARIA attributes on the dialog', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'prowlarr-title');
    expect(screen.getByText('Import from Prowlarr')).toHaveAttribute('id', 'prowlarr-title');
  });

  it('shows indexer count and change count in select step', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText(/3 indexers/)).toBeInTheDocument();
      expect(screen.getByText(/2 changes/)).toBeInTheDocument();
    });
  });

  it('sync sends correct selected state for toggled items', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockResolvedValue({ added: 0, updated: 1, removed: 0 });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    // Uncheck the first item (MyAnonaMouse = prowlarrId 1)
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(api.sync).toHaveBeenCalledWith({
        items: [
          { prowlarrId: 1, action: 'new', selected: false },
          { prowlarrId: 2, action: 'updated', selected: true },
          { prowlarrId: 3, action: 'unchanged', selected: false },
        ],
      });
    });
  });

  it('shows "Unchanged" badge for unchanged items without checkbox', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Existing')).toBeInTheDocument());

    expect(screen.getByText('Unchanged')).toBeInTheDocument();
    // Only 2 checkboxes (not 3) because unchanged items don't have checkboxes
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('shows connection failed with null message', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: false, message: null as unknown as string });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://bad:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection failed: Unknown error');
    });
  });

  it('shows sync result with removed count', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'fullSync', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockResolvedValue({ added: 1, updated: 0, removed: 2 });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Sync complete: 1 added, 2 removed');
    });
  });

  it('cancel button calls onClose on connect step', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={onClose} />);

    await user.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows loading state while fetching preview', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockReturnValue(new Promise(() => {})); // never resolves
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    expect(screen.getByText('Fetching indexers from Prowlarr...')).toBeInTheDocument();
  });

  it('displays singular indexer count for single item', async () => {
    const singleItem: SyncPreviewItem[] = [
      { prowlarrId: 1, name: 'Solo', type: 'torznab', action: 'new' },
    ];
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(singleItem);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText(/1 indexer(?!s)/)).toBeInTheDocument();
      expect(screen.getByText(/1 change(?!s)/)).toBeInTheDocument();
    });
  });

  it('shows sync failed with non-Error object', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockRejectedValue('raw string error');
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Import Selected'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Sync failed: Unknown error');
    });
  });

  it('preview failure with non-Error object shows Unknown error', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockRejectedValue('raw error');
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Next')).not.toBeDisabled());
    await user.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Preview failed: Unknown error');
    });
  });

  it('defaults to addOnly sync mode with correct description', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Only import new indexers')).toBeInTheDocument();
  });

  it('defaults categories to 3030', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByPlaceholderText('3030')).toHaveValue('3030');
  });

  it('renders category reference link', () => {
    renderWithProviders(<ProwlarrImport isOpen={true} onClose={vi.fn()} />);

    const link = screen.getByText('Reference');
    expect(link).toHaveAttribute('href', 'https://wiki.servarr.com/prowlarr/supported-indexers');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
