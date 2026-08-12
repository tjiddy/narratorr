import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SecuritySettings } from './SecuritySettings';
import { toast } from 'sonner';

vi.mock('@/lib/api', () => ({
  api: {
    getAuthConfig: vi.fn(),
    getAuthAdminStatus: vi.fn(),
    updateAuthConfig: vi.fn(),
    authSetup: vi.fn(),
    authChangePassword: vi.fn(),
    authRegenerateApiKey: vi.fn(),
    authDeleteCredentials: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      const message = (body as { error?: string })?.error || `HTTP ${status}`;
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api, ApiError } from '@/lib/api';

const mockConfig = {
  mode: 'none' as const,
  apiKey: 'test-api-key-12345',
  localBypass: false,
};

const mockStatus = {
  mode: 'none' as const,
  hasUser: false,
  localBypass: false,
  bypassActive: false,
  envBypass: false,
};

describe('SecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);
  });

  it('renders auth mode selector, API key section, local bypass toggle', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
      expect(screen.getByText('API Key')).toBeInTheDocument();
      expect(screen.getByText('Local Network Bypass')).toBeInTheDocument();
      expect(screen.getByText('test-api-key-12345')).toBeInTheDocument();
    });
  });

  it('forms/basic radio buttons disabled when no credentials exist', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
    });

    await waitFor(() => {
      const formsRadio = screen.getByLabelText('Forms (Login Page)');
      const basicRadio = screen.getByLabelText('Basic (Browser Prompt)');
      expect(formsRadio).toBeDisabled();
      expect(basicRadio).toBeDisabled();

      const noneRadio = screen.getByLabelText('None (No Authentication)');
      expect(noneRadio).not.toBeDisabled();
    });
  });

  it('mode change to "none" shows confirmation warning', async () => {
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockConfig,
      mode: 'forms',
    });
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      mode: 'forms',
      hasUser: true,
    });

    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
    });

    const noneRadio = screen.getByLabelText('None (No Authentication)');
    await user.click(noneRadio);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Disable authentication?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /disable auth/i })).toBeInTheDocument();
    });
  });

  it('API key displayed with copy functionality', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('test-api-key-12345')).toBeInTheDocument();
    });

    const codeBlock = screen.getByText('test-api-key-12345');
    expect(codeBlock.tagName).toBe('CODE');

    expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
  });

  it('regenerate API key → confirmation → new key displayed', async () => {
    (api.authRegenerateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ apiKey: 'new-key-67890' });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('API Key')).toBeInTheDocument();
    });

    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, apiKey: 'new-key-67890' });

    const regenButton = screen.getByRole('button', { name: /regenerate api key/i });
    await user.click(regenButton);

    await waitFor(() => {
      expect(screen.getByText(/regenerating will invalidate/i)).toBeInTheDocument();
    });

    const confirmButton = screen.getByRole('button', { name: /confirm regenerate/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.authRegenerateApiKey).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByText(/regenerating will invalidate/i)).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('API key regenerated');
      expect(api.getAuthConfig).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText('new-key-67890')).toBeInTheDocument();
    });
  });

  it('regenerate API key failure shows error toast', async () => {
    (api.authRegenerateApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('API Key')).toBeInTheDocument();
    });

    const regenButton = screen.getByRole('button', { name: /regenerate api key/i });
    await user.click(regenButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /confirm regenerate/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /confirm regenerate/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to regenerate API key');
    });
  });

  it('create credentials form → success message', async () => {
    (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(api.authSetup).toHaveBeenCalledWith('admin', 'password1234');
    });
  });

  it('change password form requires current password', async () => {
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toHaveValue('admin');
      expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
      expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(api.authChangePassword).toHaveBeenCalledWith('oldpass', 'newpassword1', undefined);
    });
  });

  it('setup failure shows error toast', async () => {
    const { ApiError } = await import('@/lib/api');
    (api.authSetup as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, { error: 'User already exists' }));
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('User already exists');
    });
  });

  it('setup success resets form fields', async () => {
    (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(api.authSetup).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });
  });

  it('password change failure shows error toast', async () => {
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    const { ApiError } = await import('@/lib/api');
    (api.authChangePassword as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(401, { error: 'Current password is incorrect' }));
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Current Password'), 'wrongpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Current password is incorrect');
    });
  });

  it('password change with changed username passes new username', async () => {
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    const usernameField = screen.getByLabelText('Username');
    await user.clear(usernameField);
    await user.type(usernameField, 'newadmin');
    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(api.authChangePassword).toHaveBeenCalledWith('oldpass', 'newpassword1', 'newadmin');
    });
  });

  it('setup success shows success toast and invalidates auth queries', async () => {
    (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Credentials created');
    });

    await waitFor(() => {
      expect(api.getAuthAdminStatus).toHaveBeenCalled();
    });
  });

  describe('clipboard copy', () => {
    let mockExecCommand: ReturnType<typeof vi.fn> | null = null;

    afterEach(() => {
      mockExecCommand = null;
      Object.defineProperty(document, 'execCommand', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
    });

    function mockExecCommandWith(returnValue: boolean | (() => never)) {
      mockExecCommand = typeof returnValue === 'function'
        ? vi.fn().mockImplementation(returnValue)
        : vi.fn().mockReturnValue(returnValue);
      Object.defineProperty(document, 'execCommand', {
        value: mockExecCommand,
        configurable: true,
        writable: true,
      });
      return mockExecCommand;
    }

    it('copies via navigator.clipboard.writeText when available → success toast', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      // userEvent.setup() replaces navigator.clipboard, so install this mock afterward.
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        get: () => ({ writeText }),
        configurable: true,
      });

      renderWithProviders(<SecuritySettings />);

      await waitFor(() => {
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Copy to clipboard'));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('test-api-key-12345');
        expect(toast.success).toHaveBeenCalledWith('Copied to clipboard');
      });
    });

    it('falls back to execCommand when navigator.clipboard is undefined → success toast', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
      const execCommand = mockExecCommandWith(true);

      renderWithProviders(<SecuritySettings />);

      await waitFor(() => {
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Copy to clipboard'));

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(toast.success).toHaveBeenCalledWith('Copied to clipboard');
      });
    });

    it('shows error toast when navigator.clipboard is undefined AND execCommand returns false (silent failure)', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
      mockExecCommandWith(false);

      renderWithProviders(<SecuritySettings />);

      await waitFor(() => {
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Copy to clipboard'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
      });
    });

    it('shows error toast when navigator.clipboard rejects (permissions denied)', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        get: () => ({ writeText }),
        configurable: true,
      });

      renderWithProviders(<SecuritySettings />);

      await waitFor(() => {
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Copy to clipboard'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
      });
    });

    it('shows error toast when navigator.clipboard is undefined AND execCommand throws', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
      mockExecCommandWith(() => { throw new Error('execCommand not supported'); });

      renderWithProviders(<SecuritySettings />);

      await waitFor(() => {
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Copy to clipboard'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
      });
    });
  });

  it('envBypass from query wires into CredentialsSection — Remove Credentials visible, then hidden after deletion', async () => {
    // Keep bypassActive false to prove the button is gated by envBypass.
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      bypassActive: false,
      envBypass: true,
      username: 'admin',
    });
    (api.authDeleteCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove credentials/i })).toBeInTheDocument();
    });

    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: false,
      bypassActive: false,
      envBypass: false,
    });

    await user.click(screen.getByRole('button', { name: /remove credentials/i }));

    await waitFor(() => {
      expect(api.authDeleteCredentials).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create credentials/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove credentials/i })).not.toBeInTheDocument();
    });
  });

  describe('AuthModeSection mutation flow (#93)', () => {
    it('switch to none shows confirmation dialog, then fires mutation, toast, and invalidates both auth queries', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none', apiKey: 'test-api-key-12345', localBypass: false });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'none' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'none' });

      const noneRadio = screen.getByLabelText('None (No Authentication)');
      await user.click(noneRadio);

      await waitFor(() => expect(screen.getByRole('button', { name: /disable auth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /disable auth/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ mode: 'none' }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Authentication mode updated'));
      await waitFor(() => expect(api.getAuthConfig).toHaveBeenCalled());
      await waitFor(() => expect(api.getAuthAdminStatus).toHaveBeenCalled());
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /disable auth/i })).not.toBeInTheDocument();
      });
    });

    it('switch to non-none mode fires mutation directly without confirmation dialog', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'none' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'none', hasUser: true });
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'basic', apiKey: 'test-api-key-12345', localBypass: false });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'basic' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'basic', hasUser: true });

      const basicRadio = screen.getByLabelText('Basic (Browser Prompt)');
      await user.click(basicRadio);

      expect(screen.queryByText(/are you sure you want to disable authentication/i)).not.toBeInTheDocument();

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ mode: 'basic' }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Authentication mode updated'));
      await waitFor(() => expect(api.getAuthConfig).toHaveBeenCalled());
      await waitFor(() => expect(api.getAuthAdminStatus).toHaveBeenCalled());
    });

    it('clicking already-selected mode radio is a no-op (no dialog, no mutation)', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());
      vi.clearAllMocks();

      const formsRadio = screen.getByLabelText('Forms (Login Page)');
      await user.click(formsRadio);

      expect(screen.queryByText(/are you sure you want to disable authentication/i)).not.toBeInTheDocument();
      expect(api.updateAuthConfig).not.toHaveBeenCalled();
    });

    it('mutation error on mode change shows error toast', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(403, { error: 'Custom error' }));
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));
      await waitFor(() => expect(screen.getByRole('button', { name: /disable auth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /disable auth/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Custom error'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /disable auth/i })).toBeInTheDocument();

      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none' });
      await user.click(screen.getByRole('button', { name: /disable auth/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledTimes(2));
      expect(api.updateAuthConfig).toHaveBeenLastCalledWith({ mode: 'none' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('LocalBypassSection toggle (#82)', () => {
    it('toggle fires mutation and invalidates both auth.config and auth.status queries', async () => {
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, localBypass: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).toBeInTheDocument());

      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockClear();
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, localBypass: true });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, localBypass: true });

      await user.click(screen.getByRole('checkbox', { name: /enable local bypass/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ localBypass: true }));
      await waitFor(() => expect(api.getAuthConfig).toHaveBeenCalled());
      await waitFor(() => expect(api.getAuthAdminStatus).toHaveBeenCalled());
    });

    it('toggling localBypass from false to true fires mutation and reflects checked state after refetch', async () => {
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none', apiKey: 'test-api-key-12345', localBypass: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).not.toBeChecked());
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, localBypass: true });
      await user.click(screen.getByRole('checkbox', { name: /enable local bypass/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ localBypass: true }));
      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).toBeChecked());
    });

    it('toggling localBypass from true to false fires mutation and reflects unchecked state after refetch', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, localBypass: true });
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none', apiKey: 'test-api-key-12345', localBypass: false });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).toBeChecked());
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, localBypass: false });
      await user.click(screen.getByRole('checkbox', { name: /enable local bypass/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ localBypass: false }));
      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).not.toBeChecked());
    });

    it('successful toggle shows success toast', async () => {
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none', apiKey: 'test-api-key-12345', localBypass: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).toBeInTheDocument());
      await user.click(screen.getByRole('checkbox', { name: /enable local bypass/i }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Local bypass setting updated'));
    });

    it('toggle error shows error toast', async () => {
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /enable local bypass/i })).toBeInTheDocument());
      await user.click(screen.getByRole('checkbox', { name: /enable local bypass/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update local bypass'));
    });
  });

  it('password change success shows success toast, clears fields, and invalidates auth queries', async () => {
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Credentials updated');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Current Password')).toHaveValue('');
      expect(screen.getByLabelText('New Password')).toHaveValue('');
    });

    await waitFor(() => {
      expect(api.getAuthAdminStatus).toHaveBeenCalled();
    });
  });

  describe('ConfirmModal for disable auth (#488)', () => {
    it('clicking auth mode that triggers confirmation opens ConfirmModal with title and message', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Disable authentication?')).toBeInTheDocument();
        expect(screen.getByText(/your instance will be accessible without credentials/i)).toBeInTheDocument();
      });
    });

    it('confirming in modal fires updateAuthConfig mutation with correct auth mode', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'none', apiKey: 'test-api-key-12345', localBypass: false });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /disable auth/i }));

      await waitFor(() => expect(api.updateAuthConfig).toHaveBeenCalledWith({ mode: 'none' }));
    });

    it('cancelling modal closes it without firing mutation', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.updateAuthConfig).not.toHaveBeenCalled();
    });

    it('modal dismisses on Escape key press', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.updateAuthConfig).not.toHaveBeenCalled();
    });

    it('confirm button is disabled and shows pending label while mutation is in flight', async () => {
      (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockConfig, mode: 'forms' });
      (api.getAuthAdminStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockStatus, mode: 'forms', hasUser: true });
      // Keep the mutation pending.
      (api.updateAuthConfig as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('Authentication Mode')).toBeInTheDocument());

      await user.click(screen.getByLabelText('None (No Authentication)'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /disable auth/i }));

      await waitFor(() => {
        const confirmBtn = screen.getByRole('button', { name: /updating/i });
        expect(confirmBtn).toBeDisabled();
      });
    });
  });

  describe('ConfirmModal for API key regeneration (#488)', () => {
    it('clicking regenerate button opens ConfirmModal with regeneration warning', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /regenerate api key/i }));

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Regenerate API key?')).toBeInTheDocument();
        expect(screen.getByText(/regenerating will invalidate the current key/i)).toBeInTheDocument();
      });
    });

    it('confirming fires authRegenerateApiKey mutation', async () => {
      (api.authRegenerateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ apiKey: 'new-key-67890' });
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /regenerate api key/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /confirm regenerate/i }));

      await waitFor(() => expect(api.authRegenerateApiKey).toHaveBeenCalled());
    });

    it('cancelling modal closes it without firing mutation', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /regenerate api key/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.authRegenerateApiKey).not.toHaveBeenCalled();
    });

    it('error during regeneration shows error toast and modal stays open for retry', async () => {
      (api.authRegenerateApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /regenerate api key/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /confirm regenerate/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to regenerate API key'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /confirm regenerate/i })).toBeInTheDocument();
    });

    it('confirm button is disabled and shows pending label while regeneration is in flight', async () => {
      // Keep the mutation pending.
      (api.authRegenerateApiKey as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<SecuritySettings />);

      await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /regenerate api key/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /confirm regenerate/i }));

      await waitFor(() => {
        const confirmBtn = screen.getByRole('button', { name: /regenerating/i });
        expect(confirmBtn).toBeDisabled();
      });
    });
  });
});
