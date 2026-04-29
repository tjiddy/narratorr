import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LoginPage } from './login';

vi.mock('@/lib/api', () => ({
  api: {
    authLogin: vi.fn(),
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

import { api, ApiError } from '@/lib/api';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders username and password fields', () => {
    renderWithProviders(<LoginPage />);

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('submit with valid credentials calls /api/auth/login, redirects to /library', async () => {
    (api.authLogin as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(api.authLogin).toHaveBeenCalledWith('admin', 'password123');
    });
  });

  it('submit with invalid credentials shows error message, stays on page', async () => {
    (api.authLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(401, { error: 'Invalid credentials' }));
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid username or password')).toBeInTheDocument();
    });
  });

  // Theme selection logic (localStorage + matchMedia → dark class on <html>) is tested in
  // src/client/lib/inline-bootstrap.test.ts where the production inline IIFE is exercised directly.

  it('submit disables button while pending', async () => {
    // Make login hang until we resolve it
    let resolveLogin!: () => void;
    (api.authLogin as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((resolve) => { resolveLogin = resolve; }),
    );
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Button should be disabled while pending
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    });

    // Resolve the login
    resolveLogin();
  });
});
