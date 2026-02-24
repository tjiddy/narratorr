import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockRemotePathMapping } from '@/__tests__/factories';
import { RemotePathMappingsSubsection } from './RemotePathMappingsSubsection';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getMappingsByClientId: vi.fn(),
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

const mockMapping = createMockRemotePathMapping({ id: 1, downloadClientId: 5 });

beforeEach(() => {
  vi.clearAllMocks();
  (api.getMappingsByClientId as Mock).mockResolvedValue([]);
});

describe('RemotePathMappingsSubsection', () => {
  it('renders empty state when client has no mappings', async () => {
    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText(/No path mappings configured/)).toBeInTheDocument();
    });
    expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
  });

  it('renders existing mappings with remote and local paths', async () => {
    (api.getMappingsByClientId as Mock).mockResolvedValue([mockMapping]);

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });
    expect(screen.getByText('C:\\downloads\\')).toBeInTheDocument();
  });

  it('does not show a client dropdown in the add form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));

    expect(screen.getByLabelText('Remote Path')).toBeInTheDocument();
    expect(screen.getByLabelText('Local Path')).toBeInTheDocument();
    expect(screen.queryByLabelText('Download Client')).not.toBeInTheDocument();
  });

  it('creates a mapping with the implicit client ID', async () => {
    const user = userEvent.setup();
    (api.createMapping as Mock).mockResolvedValue(mockMapping);

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

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
      downloadClientId: 5,
      remotePath: '/downloads/complete/',
      localPath: 'C:\\downloads\\',
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Path mapping added');
    });
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createMapping as Mock).mockRejectedValue(new Error('fail'));

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

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

  it('opens edit form with pre-filled values and submits update', async () => {
    const user = userEvent.setup();
    (api.getMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.updateMapping as Mock).mockResolvedValue({ ...mockMapping, remotePath: '/new/path/' });

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    expect(screen.getByLabelText('Remote Path')).toHaveValue('/downloads/complete/');
    expect(screen.getByLabelText('Local Path')).toHaveValue('C:\\downloads\\');

    await user.clear(screen.getByLabelText('Remote Path'));
    await user.type(screen.getByLabelText('Remote Path'), '/new/path/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.updateMapping).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Path mapping updated');
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.getMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.updateMapping as Mock).mockRejectedValue(new Error('fail'));

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));
    await user.clear(screen.getByLabelText('Remote Path'));
    await user.type(screen.getByLabelText('Remote Path'), '/new/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update path mapping');
    });
  });

  it('deletes mapping after confirmation', async () => {
    const user = userEvent.setup();
    (api.getMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.deleteMapping as Mock).mockResolvedValue({ success: true });

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Delete'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Path Mapping')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect((api.deleteMapping as Mock).mock.calls[0][0]).toBe(1);
    });
    expect(toast.success).toHaveBeenCalledWith('Path mapping removed');
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.getMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.deleteMapping as Mock).mockRejectedValue(new Error('fail'));

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Delete'));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete path mapping');
    });
  });

  it('fetches mappings scoped to the client ID', () => {
    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    expect(api.getMappingsByClientId).toHaveBeenCalledWith(5);
  });

  it('Save button does not submit a parent form (regression #225)', async () => {
    const user = userEvent.setup();
    const parentSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    (api.createMapping as Mock).mockResolvedValue(mockMapping);

    renderWithProviders(
      <form onSubmit={parentSubmit}>
        <RemotePathMappingsSubsection clientId={5} />
      </form>,
    );

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '/remote/');
    await user.type(screen.getByLabelText('Local Path'), '/local/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.createMapping).toHaveBeenCalled();
    });
    expect(parentSubmit).not.toHaveBeenCalled();
  });

  it('Save button is disabled when fields are empty', async () => {
    const user = userEvent.setup();

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));

    expect(screen.getByText('Save')).toBeDisabled();
  });
});
