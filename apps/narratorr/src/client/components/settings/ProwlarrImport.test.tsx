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
});
