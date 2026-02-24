import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockDownloadClient, createMockRemotePathMapping } from '@/__tests__/factories';
import { RemotePathMappingsSection } from './RemotePathMappingsSection';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getMappings: vi.fn(),
    getClients: vi.fn(),
    createMapping: vi.fn(),
    updateMapping: vi.fn(),
    deleteMapping: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockClient = createMockDownloadClient({ id: 1, name: 'SABnzbd' });
const mockMapping = createMockRemotePathMapping({ id: 1, downloadClientId: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  (api.getClients as Mock).mockResolvedValue([mockClient]);
  (api.getMappings as Mock).mockResolvedValue([]);
});

describe('RemotePathMappingsSection', () => {
  it('renders empty state when no mappings exist', async () => {
    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/No path mappings configured/)).toBeInTheDocument();
    });
    expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
  });

  it('renders mapping list with client name, remote path, and local path', async () => {
    (api.getMappings as Mock).mockResolvedValue([mockMapping]);

    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('SABnzbd')).toBeInTheDocument();
    });
    expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    expect(screen.getByText('C:\\downloads\\')).toBeInTheDocument();
  });

  it('shows add form when Add Mapping is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));

    expect(screen.getByLabelText('Download Client')).toBeInTheDocument();
    expect(screen.getByLabelText('Remote Path')).toBeInTheDocument();
    expect(screen.getByLabelText('Local Path')).toBeInTheDocument();
  });

  it('submits new mapping and shows success toast', async () => {
    const user = userEvent.setup();
    (api.createMapping as Mock).mockResolvedValue(mockMapping);

    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '/downloads/complete/');
    await user.type(screen.getByLabelText('Local Path'), 'C:\\downloads\\');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.createMapping).toHaveBeenCalled();
    });
    expect((api.createMapping as Mock).mock.calls[0][0]).toMatchObject({
      downloadClientId: 1,
      remotePath: '/downloads/complete/',
      localPath: 'C:\\downloads\\',
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Path mapping added');
    });
  });

  it('shows error toast when save fails', async () => {
    const user = userEvent.setup();
    (api.createMapping as Mock).mockRejectedValue(new Error('fail'));

    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '/test/');
    await user.type(screen.getByLabelText('Local Path'), '/local/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add path mapping');
    });
  });

  it('opens edit form and submits update', async () => {
    const user = userEvent.setup();
    (api.getMappings as Mock).mockResolvedValue([mockMapping]);
    (api.updateMapping as Mock).mockResolvedValue({ ...mockMapping, remotePath: '/new/path/' });

    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('SABnzbd')).toBeInTheDocument();
    });

    // Click Edit on the mapping row
    await user.click(screen.getByText('Edit'));

    // Edit form should appear with pre-filled values
    expect(screen.getByLabelText('Remote Path')).toHaveValue('/downloads/complete/');

    // Clear and type new value
    await user.clear(screen.getByLabelText('Remote Path'));
    await user.type(screen.getByLabelText('Remote Path'), '/new/path/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.updateMapping).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Path mapping updated');
  });

  it('deletes mapping after confirmation', async () => {
    const user = userEvent.setup();
    (api.getMappings as Mock).mockResolvedValue([mockMapping]);
    (api.deleteMapping as Mock).mockResolvedValue({ success: true });

    renderWithProviders(<RemotePathMappingsSection />);

    await waitFor(() => {
      expect(screen.getByText('SABnzbd')).toBeInTheDocument();
    });

    // Click Delete
    await user.click(screen.getByText('Delete'));

    // Confirmation modal should appear
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Path Mapping')).toBeInTheDocument();

    // Confirm deletion via the modal's Delete button
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect((api.deleteMapping as Mock).mock.calls[0][0]).toBe(1);
    });
    expect(toast.success).toHaveBeenCalledWith('Path mapping removed');
  });

  it('does not render when no download clients exist', async () => {
    (api.getClients as Mock).mockResolvedValue([]);

    const { container } = renderWithProviders(<RemotePathMappingsSection />);

    // Wait for both queries to settle — component returns null when clients=[] and mappings loaded
    await waitFor(() => {
      expect(api.getClients).toHaveBeenCalled();
      expect(api.getMappings).toHaveBeenCalled();
      expect(container.querySelector('h3')).toBeNull();
    });
  });
});
