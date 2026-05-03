import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { CredentialsSection } from './CredentialsSection';
import { toast } from 'sonner';

vi.mock('@/lib/api', () => ({
  api: {
    authSetup: vi.fn(),
    authChangePassword: vi.fn(),
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
// Cast to access all mocked methods
const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('CredentialsSection', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  describe('setup form (hasUser=false)', () => {
    function renderSetup() {
      return renderWithProviders(
        <CredentialsSection hasUser={false} />,
        { queryClient },
      );
    }

    it('renders username and password fields', () => {
      renderSetup();
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create Credentials' })).toBeInTheDocument();
    });

    it('calls api.authSetup with entered username and password on submit', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(api.authSetup).toHaveBeenCalledWith('admin', 'password123');
      });
    });

    it('shows success toast and clears form fields on success', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Credentials created');
      });

      expect(screen.getByLabelText('Username')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveValue('');
      expect(screen.getByLabelText('Confirm Password')).toHaveValue('');
    });

    it('invalidates auth status query on success', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: ['auth', 'status'] }),
        );
      });
    });

    it('shows API error message on ApiError', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(400, { error: 'Username already exists' }),
      );
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Username already exists');
      });
    });

    it('shows fallback error message on generic error', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network fail'));
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to create credentials');
      });
    });

    it('shows Creating... and disables button while pending', async () => {
      const user = userEvent.setup();
      let resolve!: () => void;
      (api.authSetup as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<void>((r) => { resolve = r; }),
      );
      renderSetup();

      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.type(screen.getByLabelText('Confirm Password'), 'password123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
      });

      resolve();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Credentials' })).toBeEnabled();
      });
    });
  });

  describe('change password form (hasUser=true)', () => {
    function renderChangePassword(currentUsername = 'admin') {
      return renderWithProviders(
        <CredentialsSection hasUser={true} currentUsername={currentUsername} />,
        { queryClient },
      );
    }

    it('renders edit form with username pre-filled from currentUsername prop', () => {
      renderChangePassword('testuser');
      expect(screen.getByLabelText('Username')).toHaveValue('testuser');
      expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
      expect(screen.getByLabelText('New Password')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
    });

    it('passes new username to authChangePassword when username changed', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderChangePassword('admin');

      await user.clear(screen.getByLabelText('Username'));
      await user.type(screen.getByLabelText('Username'), 'newadmin');
      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(api.authChangePassword).toHaveBeenCalledWith('oldpass123', 'newpass123', 'newadmin');
      });
    });

    it('passes undefined for newUsername when username unchanged', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderChangePassword('admin');

      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(api.authChangePassword).toHaveBeenCalledWith('oldpass123', 'newpass123', undefined);
      });
    });

    it('shows success toast and clears password fields but preserves username on success', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderChangePassword('admin');

      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Credentials updated');
      });

      expect(screen.getByLabelText('Username')).toHaveValue('admin');
      expect(screen.getByLabelText('Current Password')).toHaveValue('');
      expect(screen.getByLabelText('New Password')).toHaveValue('');
      expect(screen.getByLabelText('Confirm New Password')).toHaveValue('');
    });

    it('invalidates auth status query on success', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderChangePassword();

      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: ['auth', 'status'] }),
        );
      });
    });

    it('shows API error message on ApiError', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(401, { error: 'Current password is incorrect' }),
      );
      renderChangePassword();

      await user.type(screen.getByLabelText('Current Password'), 'wrongpass');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Current password is incorrect');
      });
    });

    it('shows fallback error message on generic error', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      renderChangePassword();

      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to change password');
      });
    });

    it('shows Updating... and disables button while pending', async () => {
      const user = userEvent.setup();
      let resolve!: () => void;
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<void>((r) => { resolve = r; }),
      );
      renderChangePassword();

      await user.type(screen.getByLabelText('Current Password'), 'oldpass123');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Updating...' })).toBeDisabled();
      });

      resolve();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Change Password' })).toBeEnabled();
      });
    });
  });

  describe('conditional rendering', () => {
    it('renders setup form when hasUser=false', () => {
      renderWithProviders(<CredentialsSection hasUser={false} />, { queryClient });
      expect(screen.getByRole('button', { name: 'Create Credentials' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument();
    });

    it('renders change password form when hasUser=true', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" />, { queryClient });
      expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create Credentials' })).not.toBeInTheDocument();
    });
  });

  describe('HTML constraint attributes', () => {
    it('setup form: username has required, password has required and no minLength', () => {
      renderWithProviders(<CredentialsSection hasUser={false} />, { queryClient });
      const username = screen.getByLabelText('Username');
      const password = screen.getByLabelText('Password');
      expect(username).toBeRequired();
      expect(password).toBeRequired();
      expect(password).not.toHaveAttribute('minLength');
    });

    it('setup form: placeholder does not reference "8 characters"', () => {
      renderWithProviders(<CredentialsSection hasUser={false} />, { queryClient });
      const password = screen.getByLabelText('Password');
      expect(password.getAttribute('placeholder') ?? '').not.toMatch(/8 characters/i);
    });

    it('change password form: username required, current password required, new password required without minLength', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" />, { queryClient });
      const username = screen.getByLabelText('Username');
      const currentPw = screen.getByLabelText('Current Password');
      const newPw = screen.getByLabelText('New Password');
      expect(username).toBeRequired();
      expect(currentPw).toBeRequired();
      expect(newPw).toBeRequired();
      expect(newPw).not.toHaveAttribute('minLength');
    });

    it('change password form: placeholder does not reference "8 characters"', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" />, { queryClient });
      const newPw = screen.getByLabelText('New Password');
      expect(newPw.getAttribute('placeholder') ?? '').not.toMatch(/8 characters/i);
    });
  });

  describe('autocomplete attributes', () => {
    it('setup form: password input has autoComplete="new-password"', () => {
      renderWithProviders(<CredentialsSection hasUser={false} />, { queryClient });
      const password = screen.getByLabelText('Password');
      expect(password).toHaveAttribute('autoComplete', 'new-password');
    });

    it('change password form: current password has autoComplete="current-password"', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" />, { queryClient });
      const currentPw = screen.getByLabelText('Current Password');
      expect(currentPw).toHaveAttribute('autoComplete', 'current-password');
    });

    it('change password form: new password has autoComplete="new-password"', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" />, { queryClient });
      const newPw = screen.getByLabelText('New Password');
      expect(newPw).toHaveAttribute('autoComplete', 'new-password');
    });
  });

  describe('confirm password — setup form', () => {
    function renderSetup() {
      return renderWithProviders(<CredentialsSection hasUser={false} />, { queryClient });
    }

    it('renders a Confirm Password field', () => {
      renderSetup();
      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    });

    it('submitting with matching passwords calls api.authSetup', async () => {
      const user = userEvent.setup();
      (api.authSetup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderSetup();
      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'pass123');
      await user.type(screen.getByLabelText('Confirm Password'), 'pass123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));
      await waitFor(() => {
        expect(api.authSetup).toHaveBeenCalledWith('admin', 'pass123');
      });
    });

    it('submitting with mismatched passwords shows inline error and does not call API', async () => {
      const user = userEvent.setup();
      renderSetup();
      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'pass123');
      await user.type(screen.getByLabelText('Confirm Password'), 'different');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));
      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      });
      expect(api.authSetup).not.toHaveBeenCalled();
    });

    it('submitting with empty confirm password shows inline error and does not call API', async () => {
      const user = userEvent.setup();
      renderSetup();
      await user.type(screen.getByLabelText('Username'), 'admin');
      await user.type(screen.getByLabelText('Password'), 'pass123');
      await user.click(screen.getByRole('button', { name: 'Create Credentials' }));
      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      });
      expect(api.authSetup).not.toHaveBeenCalled();
    });
  });

  describe('confirm password — change password form', () => {
    function renderChangePassword(currentUsername = 'admin') {
      return renderWithProviders(
        <CredentialsSection hasUser={true} currentUsername={currentUsername} />,
        { queryClient },
      );
    }

    it('renders a Confirm New Password field', () => {
      renderChangePassword();
      expect(screen.getByLabelText('Confirm New Password')).toBeInTheDocument();
    });

    it('submitting with matching new passwords calls api.authChangePassword', async () => {
      const user = userEvent.setup();
      (api.authChangePassword as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      renderChangePassword();
      await user.type(screen.getByLabelText('Current Password'), 'oldpass');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));
      await waitFor(() => {
        expect(api.authChangePassword).toHaveBeenCalled();
      });
    });

    it('submitting with mismatched new passwords shows inline error and does not call API', async () => {
      const user = userEvent.setup();
      renderChangePassword();
      await user.type(screen.getByLabelText('Current Password'), 'oldpass');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.type(screen.getByLabelText('Confirm New Password'), 'different');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));
      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      });
      expect(api.authChangePassword).not.toHaveBeenCalled();
    });

    it('submitting with empty confirm new password shows inline error and does not call API', async () => {
      const user = userEvent.setup();
      renderChangePassword();
      await user.type(screen.getByLabelText('Current Password'), 'oldpass');
      await user.type(screen.getByLabelText('New Password'), 'newpass123');
      await user.click(screen.getByRole('button', { name: 'Change Password' }));
      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      });
      expect(api.authChangePassword).not.toHaveBeenCalled();
    });
  });

  describe('remove credentials (envBypass=true)', () => {
    it('Remove Credentials button is visible when envBypass=true and hasUser=true', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" envBypass={true} />, { queryClient });
      expect(screen.getByRole('button', { name: 'Remove Credentials' })).toBeInTheDocument();
    });

    it('Remove Credentials button is NOT visible when envBypass=false', () => {
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" envBypass={false} />, { queryClient });
      expect(screen.queryByRole('button', { name: 'Remove Credentials' })).not.toBeInTheDocument();
    });

    it('Remove Credentials button is NOT visible when envBypass=true but hasUser=false', () => {
      renderWithProviders(<CredentialsSection hasUser={false} envBypass={true} />, { queryClient });
      expect(screen.queryByRole('button', { name: 'Remove Credentials' })).not.toBeInTheDocument();
    });

    it('clicking Remove Credentials calls delete endpoint and invalidates auth queries and switches to setup view', async () => {
      const user = userEvent.setup();
      mockApi.authDeleteCredentials!.mockResolvedValue({ success: true });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" envBypass={true} />, { queryClient });
      await user.click(screen.getByRole('button', { name: 'Remove Credentials' }));
      await waitFor(() => {
        expect(mockApi.authDeleteCredentials).toHaveBeenCalled();
        expect(invalidateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: ['auth', 'status'] }),
        );
        expect(toast.success).toHaveBeenCalledWith('Credentials removed');
      });
    });

    it('Remove Credentials API failure shows error toast and preserves form state', async () => {
      const user = userEvent.setup();
      mockApi.authDeleteCredentials!.mockRejectedValue(new ApiError(403, { error: 'Only available when AUTH_BYPASS is active' }));
      renderWithProviders(<CredentialsSection hasUser={true} currentUsername="admin" envBypass={true} />, { queryClient });
      await user.click(screen.getByRole('button', { name: 'Remove Credentials' }));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Only available when AUTH_BYPASS is active');
      });
      // Change password form should still be visible (form state preserved)
      expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('currentUsername undefined with hasUser=true initializes edit username to empty string', () => {
      renderWithProviders(<CredentialsSection hasUser={true} />, { queryClient });
      expect(screen.getByLabelText('Username')).toHaveValue('');
    });
  });
});
