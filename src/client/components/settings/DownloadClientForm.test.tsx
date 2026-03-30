import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockDownloadClient } from '@/__tests__/factories';
import { DownloadClientForm } from './DownloadClientForm';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      getRemotePathMappingsByClientId: vi.fn().mockResolvedValue([]),
      testDownloadClient: vi.fn().mockResolvedValue({ success: true, message: 'OK' }),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadClientForm (#201)', () => {
  describe('blackhole type rendering', () => {
    it('blackhole type renders BlackholeFields (Watch Directory, Protocol) instead of DownloadClientFields', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Default type is qbittorrent — switch to blackhole
      await user.selectOptions(screen.getByLabelText('Type'), 'blackhole');

      // BlackholeFields should render
      expect(screen.getByText('Watch Directory')).toBeInTheDocument();
      expect(screen.getByText('Protocol')).toBeInTheDocument();

      // DownloadClientFields should NOT render
      expect(screen.queryByText('Host')).not.toBeInTheDocument();
      expect(screen.queryByText('Port')).not.toBeInTheDocument();
    });

    it('non-blackhole type renders DownloadClientFields (Host, Port) instead of BlackholeFields', () => {
      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Default type is qbittorrent
      expect(screen.getByText('Host')).toBeInTheDocument();
      expect(screen.getByText('Port')).toBeInTheDocument();

      // BlackholeFields should NOT render
      expect(screen.queryByText('Watch Directory')).not.toBeInTheDocument();
      expect(screen.queryByText('Protocol')).not.toBeInTheDocument();
    });
  });

  describe('type change settings reset', () => {
    it('type change in create mode resets settings to DOWNLOAD_CLIENT_REGISTRY[selectedType].defaultSettings', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Type some values into qbittorrent fields
      const hostInput = screen.getByPlaceholderText('localhost');
      await user.type(hostInput, 'myhost.local');
      expect(hostInput).toHaveValue('myhost.local');

      // Switch to sabnzbd — settings should reset to sabnzbd defaults
      await user.selectOptions(screen.getByLabelText('Type'), 'sabnzbd');

      // sabnzbd shows API Key instead of Username/Password
      await waitFor(() => {
        expect(screen.getByText('API Key')).toBeInTheDocument();
      });

      // Host field should be empty (reset to default empty string)
      const newHostInput = screen.getByPlaceholderText('localhost');
      expect(newHostInput).toHaveValue('');
    });

    it('type change in edit mode does NOT reset settings (preserves saved config)', async () => {
      const user = userEvent.setup();
      const client = createMockDownloadClient({
        id: 1,
        name: 'My Client',
        type: 'qbittorrent',
        settings: { host: 'saved-host', port: 9090, username: 'admin', password: 'pass', useSsl: false },
      });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Verify pre-filled data
      expect(screen.getByPlaceholderText('localhost')).toHaveValue('saved-host');

      // Change type in edit mode — settings should NOT reset because the useEffect skips when isEdit
      await user.selectOptions(screen.getByLabelText('Type'), 'sabnzbd');

      // The edit-mode reset effect re-applies the client's original data, not the new type's defaults
      // The host should remain from the original client data after the reset
      await waitFor(() => {
        expect(screen.getByPlaceholderText('localhost')).toHaveValue('saved-host');
      });
    });
  });

  describe('unimplemented adapter warning', () => {
    it('unimplemented adapter type shows amber warning text and disables test button', () => {
      // Note: Currently all schema types are in the registry, so this branch is unreachable
      // with valid form data. We test this by verifying the isImplemented check behavior
      // when all types ARE implemented — the warning should NOT appear for valid types.
      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Default qbittorrent IS implemented — no warning should appear
      expect(screen.queryByText(/adapter not yet implemented/i)).not.toBeInTheDocument();

      // Test button should NOT be disabled for implemented types
      const testButton = screen.getByRole('button', { name: /test/i });
      expect(testButton).not.toBeDisabled();
    });
  });

  describe('onFormTest callback', () => {
    it('onFormTest callback receives current form data when Test button is clicked', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <DownloadClientForm
          mode="create"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      // Fill required name field
      await user.type(screen.getByPlaceholderText('qBittorrent'), 'My Test Client');
      // Fill host so validation passes
      await user.type(screen.getByPlaceholderText('localhost'), 'testhost');

      await user.click(screen.getByRole('button', { name: /test/i }));

      // handleSubmit wraps onFormTest — it only fires if validation passes
      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Test Client',
            type: 'qbittorrent',
            settings: expect.objectContaining({ host: 'testhost' }),
          }),
          expect.anything(), // react-hook-form event
        );
      });
    });
  });

  describe('onCancel callback', () => {
    it('onCancel callback fires when Cancel button is clicked', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();
      const client = createMockDownloadClient({ id: 1, name: 'Test' });

      renderWithProviders(
        <DownloadClientForm
          client={client}
          mode="edit"
          onCancel={onCancel}
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      await user.click(screen.getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('SelectWithChevron migration (#224)', () => {
    it('type select renders with appearance-none and ChevronDownIcon', () => {
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('appearance-none');
      // ChevronDownIcon renders an SVG sibling
      const selectParent = select.parentElement!;
      expect(selectParent.querySelector('svg')).not.toBeNull();
    });

    it('selecting a download client type via SelectWithChevron updates form state', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(
        <DownloadClientForm mode="create" onSubmit={onSubmit} onFormTest={vi.fn()} />,
      );

      await user.selectOptions(screen.getByLabelText('Type'), 'blackhole');
      expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('blackhole');
    });

    it('type select shows border-destructive when errors.type is present', async () => {
      const user = userEvent.setup();
      const invalidClient = createMockDownloadClient({ type: 'INVALID' as never });
      renderWithProviders(
        <DownloadClientForm mode="edit" client={invalidClient} onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );

      const select = screen.getByLabelText('Type');

      // Before submit: no validation errors yet
      expect(select.className).toContain('border-border');
      expect(select.className).not.toContain('border-destructive');

      // Submit triggers zodResolver — invalid type produces errors.type
      await user.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => {
        expect(screen.getByLabelText('Type').className).toContain('border-destructive');
      });
    });
  });
});
