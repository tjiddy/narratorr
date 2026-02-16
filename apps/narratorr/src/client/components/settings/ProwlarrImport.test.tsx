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
  it('renders form fields and header', () => {
    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    expect(screen.getByText('Import from Prowlarr')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('http://localhost:9696')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your Prowlarr API key')).toBeInTheDocument();
    expect(screen.getByText('Add Only')).toBeInTheDocument();
    expect(screen.getByText('Full Sync')).toBeInTheDocument();
  });

  it('test button calls testConnection with url and apiKey', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

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

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://bad:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection failed: Refused');
    });
  });

  it('save & preview is disabled until test passes', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');

    const saveBtn = screen.getByText('Save & Preview');
    expect(saveBtn).toBeDisabled();
  });

  it('save & preview is enabled after successful test', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Save & Preview')).not.toBeDisabled();
    });
  });

  it('changing URL resets test state and disables preview', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Save & Preview')).not.toBeDisabled();
    });

    // Change URL — should reset testPassed
    await user.type(screen.getByPlaceholderText('http://localhost:9696'), '/v2');

    expect(screen.getByText('Save & Preview')).toBeDisabled();
  });

  it('save & preview calls save then preview', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('Save & Preview')).not.toBeDisabled();
    });

    await user.click(screen.getByText('Save & Preview'));

    await waitFor(() => {
      expect(api.saveConfig).toHaveBeenCalled();
      expect(api.preview).toHaveBeenCalled();
    });
  });

  it('renders preview table with action badges', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Save & Preview')).not.toBeDisabled());
    await user.click(screen.getByText('Save & Preview'));

    await waitFor(() => {
      expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument();
      expect(screen.getByText('NZBgeek')).toBeInTheDocument();
      expect(screen.getByText('Existing')).toBeInTheDocument();
    });

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
    expect(screen.getByText('Unchanged')).toBeInTheDocument();
    // Header shows change count
    expect(screen.getByText('(2 changes)')).toBeInTheDocument();
  });

  it('checkboxes default to selected for non-unchanged items', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Save & Preview')).not.toBeDisabled());
    await user.click(screen.getByText('Save & Preview'));

    await waitFor(() => {
      expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    // 2 checkboxes: new and updated (unchanged has none)
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it('apply sends selected items and shows success toast', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    vi.mocked(api.sync).mockResolvedValue({ added: 1, updated: 1, removed: 0 });
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Save & Preview')).not.toBeDisabled());
    await user.click(screen.getByText('Save & Preview'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Apply Changes'));

    await waitFor(() => {
      expect(api.sync).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Sync complete: 1 added, 1 updated');
    });
  });

  it('cancel clears preview table', async () => {
    vi.mocked(api.testConnection).mockResolvedValue({ success: true, message: 'OK' });
    vi.mocked(api.saveConfig).mockResolvedValue({
      url: 'http://prowlarr:9696', apiKey: 'key', syncMode: 'addOnly', categories: [3030],
    });
    vi.mocked(api.preview).mockResolvedValue(mockPreviewItems);
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('http://localhost:9696'), 'http://prowlarr:9696');
    await user.type(screen.getByPlaceholderText('Your Prowlarr API key'), 'key');
    await user.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText('Save & Preview')).not.toBeDisabled());
    await user.click(screen.getByText('Save & Preview'));
    await waitFor(() => expect(screen.getByText('MyAnonaMouse')).toBeInTheDocument());

    await user.click(screen.getByText('Cancel'));

    expect(screen.queryByText('MyAnonaMouse')).not.toBeInTheDocument();
  });

  it('close button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={onClose} />);

    // The X button is the only button with XIcon
    const closeBtn = screen.getByText('Import from Prowlarr')
      .closest('.flex')!
      .querySelector('button:last-child') as HTMLElement;
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalled();
  });

  it('sync mode toggles between addOnly and fullSync', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProwlarrImport onClose={vi.fn()} />);

    const fullSyncBtn = screen.getByText('Full Sync');
    await user.click(fullSyncBtn);

    expect(screen.getByText('Add, update, and remove to match Prowlarr state')).toBeInTheDocument();

    const addOnlyBtn = screen.getByText('Add Only');
    await user.click(addOnlyBtn);

    expect(screen.getByText('Import new indexers, never update or remove existing')).toBeInTheDocument();
  });
});
