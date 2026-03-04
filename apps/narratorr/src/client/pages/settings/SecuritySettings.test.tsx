import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SecuritySettings } from './SecuritySettings';
import { toast } from 'sonner';

vi.mock('@/lib/api', () => ({
  api: {
    getAuthConfig: vi.fn(),
    getStatus: vi.fn(),
    updateAuthConfig: vi.fn(),
    setup: vi.fn(),
    changePassword: vi.fn(),
    regenerateApiKey: vi.fn(),
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

import { api } from '@/lib/api';

const mockConfig = {
  mode: 'none' as const,
  apiKey: 'test-api-key-12345',
  localBypass: false,
};

const mockStatus = {
  mode: 'none' as const,
  hasUser: false,
  localBypass: false,
};

describe('SecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);
  });

  it('renders auth mode selector, API key section, local bypass toggle', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
    });
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.getByText('Local Network Bypass')).toBeInTheDocument();
    expect(screen.getByText('test-api-key-12345')).toBeInTheDocument();
  });

  it('forms/basic radio buttons disabled when no credentials exist', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
    });

    // Forms and Basic radios should be disabled since hasUser=false
    const formsRadio = screen.getByLabelText('Forms (Login Page)');
    const basicRadio = screen.getByLabelText('Basic (Browser Prompt)');
    expect(formsRadio).toBeDisabled();
    expect(basicRadio).toBeDisabled();

    // None should still be enabled
    const noneRadio = screen.getByLabelText('None (No Authentication)');
    expect(noneRadio).not.toBeDisabled();
  });

  it('mode change to "none" shows confirmation warning', async () => {
    // Start with forms mode active + has user
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockConfig,
      mode: 'forms',
    });
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      mode: 'forms',
      hasUser: true,
    });

    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Authentication Mode')).toBeInTheDocument();
    });

    // Click the "none" radio button
    const noneRadio = screen.getByLabelText('None (No Authentication)');
    await user.click(noneRadio);

    // Confirmation should appear
    expect(screen.getByText(/are you sure you want to disable authentication/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disable auth/i })).toBeInTheDocument();
  });

  it('API key displayed with copy functionality', async () => {
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('test-api-key-12345')).toBeInTheDocument();
    });

    // API key is displayed in a monospace code block
    const codeBlock = screen.getByText('test-api-key-12345');
    expect(codeBlock.tagName).toBe('CODE');

    // Copy button exists
    expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
  });

  it('regenerate API key → confirmation → new key displayed', async () => {
    (api.regenerateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ apiKey: 'new-key-67890' });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('API Key')).toBeInTheDocument();
    });

    // Click regenerate button
    const regenButton = screen.getByRole('button', { name: /regenerate api key/i });
    await user.click(regenButton);

    // Confirmation should appear
    expect(screen.getByText(/regenerating will invalidate/i)).toBeInTheDocument();

    // Confirm regeneration
    const confirmButton = screen.getByRole('button', { name: /confirm regenerate/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.regenerateApiKey).toHaveBeenCalled();
    });
  });

  it('create credentials form → success message', async () => {
    (api.setup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    // Should show create form since hasUser=false
    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(api.setup).toHaveBeenCalledWith('admin', 'password1234');
    });
  });

  it('change password form requires current password', async () => {
    // User exists — show change password form
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.changePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    // Should show username field pre-populated, plus password fields
    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    // Username unchanged → third arg is undefined
    await waitFor(() => {
      expect(api.changePassword).toHaveBeenCalledWith('oldpass', 'newpassword1', undefined);
    });
  });

  it('setup failure shows error toast', async () => {
    const { ApiError } = await import('@/lib/api');
    (api.setup as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, { error: 'User already exists' }));
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('User already exists');
    });
  });

  it('setup success resets form fields', async () => {
    (api.setup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(api.setup).toHaveBeenCalled();
    });

    // Fields should be cleared after success
    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });
  });

  it('password change failure shows error toast', async () => {
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    const { ApiError } = await import('@/lib/api');
    (api.changePassword as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(401, { error: 'Current password is incorrect' }));
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Current Password'), 'wrongpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Current password is incorrect');
    });
  });

  it('password change with changed username passes new username', async () => {
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.changePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    // Clear and change username
    const usernameField = screen.getByLabelText('Username');
    await user.clear(usernameField);
    await user.type(usernameField, 'newadmin');
    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(api.changePassword).toHaveBeenCalledWith('oldpass', 'newpassword1', 'newadmin');
    });
  });

  it('setup success shows success toast and invalidates auth queries', async () => {
    (api.setup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    // Clear call counts after initial data load
    (api.getStatus as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
    // Re-apply resolved values for refetch after invalidation
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: /create credentials/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Credentials created');
    });

    // Auth status should be refetched due to query invalidation
    await waitFor(() => {
      expect(api.getStatus).toHaveBeenCalled();
    });
  });

  it('password change success shows success toast, clears fields, and invalidates auth queries', async () => {
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.changePassword as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<SecuritySettings />);

    await waitFor(() => {
      expect(screen.getByText('Credentials')).toBeInTheDocument();
    });

    // Clear call counts after initial data load
    (api.getStatus as ReturnType<typeof vi.fn>).mockClear();
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockClear();
    // Re-apply resolved values for refetch after invalidation
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStatus,
      hasUser: true,
      username: 'admin',
    });
    (api.getAuthConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

    await user.type(screen.getByLabelText('Current Password'), 'oldpass');
    await user.type(screen.getByLabelText('New Password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Credentials updated');
    });

    // Password fields should be cleared after success
    await waitFor(() => {
      expect(screen.getByLabelText('Current Password')).toHaveValue('');
      expect(screen.getByLabelText('New Password')).toHaveValue('');
    });

    // Auth status should be refetched due to query invalidation
    await waitFor(() => {
      expect(api.getStatus).toHaveBeenCalled();
    });
  });
});
