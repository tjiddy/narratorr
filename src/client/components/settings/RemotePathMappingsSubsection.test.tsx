import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockRemotePathMapping } from '@/__tests__/factories';
import { RemotePathMappingsSubsection } from './RemotePathMappingsSubsection';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getRemotePathMappingsByClientId: vi.fn(),
    createRemotePathMapping: vi.fn(),
    updateRemotePathMapping: vi.fn(),
    deleteRemotePathMapping: vi.fn(),
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
  (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([]);
});

describe('RemotePathMappingsSubsection', () => {
  it('renders empty state when client has no mappings', async () => {
    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText(/No path mappings configured/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });
  });

  it('renders existing mappings with remote and local paths', async () => {
    (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([mockMapping]);

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('C:\\downloads\\')).toBeInTheDocument();
    });
  });

  it('does not show a client dropdown in the add form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));

    await waitFor(() => {
      expect(screen.getByLabelText('Remote Path')).toBeInTheDocument();
      expect(screen.getByLabelText('Local Path')).toBeInTheDocument();
      expect(screen.queryByLabelText('Download Client')).not.toBeInTheDocument();
    });
  });

  it('creates a mapping with the implicit client ID', async () => {
    const user = userEvent.setup();
    (api.createRemotePathMapping as Mock).mockResolvedValue(mockMapping);

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '/downloads/complete/');
    await user.type(screen.getByLabelText('Local Path'), 'C:\\downloads\\');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.createRemotePathMapping).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect((api.createRemotePathMapping as Mock).mock.calls[0][0]).toMatchObject({
        downloadClientId: 5,
        remotePath: '/downloads/complete/',
        localPath: 'C:\\downloads\\',
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Path mapping added');
    });

    // onSuccess callback closes the add form
    await waitFor(() => {
      expect(screen.queryByLabelText('Remote Path')).not.toBeInTheDocument();
    });
  });

  it('shows error toast when create fails', async () => {
    const user = userEvent.setup();
    (api.createRemotePathMapping as Mock).mockRejectedValue(new Error('fail'));

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
    (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.updateRemotePathMapping as Mock).mockResolvedValue({ ...mockMapping, remotePath: '/new/path/' });

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(screen.getByLabelText('Remote Path')).toHaveValue('/downloads/complete/');
      expect(screen.getByLabelText('Local Path')).toHaveValue('C:\\downloads\\');
    });

    await user.clear(screen.getByLabelText('Remote Path'));
    await user.type(screen.getByLabelText('Remote Path'), '/new/path/');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.updateRemotePathMapping).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Path mapping updated');
    });

    // onSuccess callback closes the edit form and returns to display mode
    await waitFor(() => {
      expect(screen.queryByLabelText('Remote Path')).not.toBeInTheDocument();
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });
  });

  it('shows error toast when update fails', async () => {
    const user = userEvent.setup();
    (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.updateRemotePathMapping as Mock).mockRejectedValue(new Error('fail'));

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
    (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.deleteRemotePathMapping as Mock).mockResolvedValue({ success: true });

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('/downloads/complete/')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Delete'));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByText('Delete Path Mapping')).toBeInTheDocument();
    });

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect((api.deleteRemotePathMapping as Mock).mock.calls[0][0]).toBe(1);
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Path mapping removed');
    });
  });

  it('shows error toast when delete fails', async () => {
    const user = userEvent.setup();
    (api.getRemotePathMappingsByClientId as Mock).mockResolvedValue([mockMapping]);
    (api.deleteRemotePathMapping as Mock).mockRejectedValue(new Error('fail'));

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

    expect(api.getRemotePathMappingsByClientId).toHaveBeenCalledWith(5);
  });

  it('Save button does not submit a parent form (regression #225)', async () => {
    const user = userEvent.setup();
    const parentSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    (api.createRemotePathMapping as Mock).mockResolvedValue(mockMapping);

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
      expect(api.createRemotePathMapping).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(parentSubmit).not.toHaveBeenCalled();
    });
  });

  it('Save button is disabled when fields are empty', async () => {
    const user = userEvent.setup();

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeDisabled();
    });
  });

  it('does not submit when remote path is whitespace-only', async () => {
    const user = userEvent.setup();

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '   ');
    await user.type(screen.getByLabelText('Local Path'), '/valid/path');

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeDisabled();
    });
  });

  it('does not submit when local path is whitespace-only', async () => {
    const user = userEvent.setup();

    renderWithProviders(<RemotePathMappingsSubsection clientId={5} />);

    await waitFor(() => {
      expect(screen.getByText('Remote Path Mappings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByLabelText('Remote Path'), '/valid/path');
    await user.type(screen.getByLabelText('Local Path'), '   ');

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeDisabled();
    });
  });
});
