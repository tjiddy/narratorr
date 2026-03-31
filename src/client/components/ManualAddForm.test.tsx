import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualAddForm } from './ManualAddForm';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        quality: { searchImmediately: true, monitorForUpgrades: false },
      }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderForm(props: { defaultTitle?: string; onSuccess?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ManualAddForm {...props} />
      </QueryClientProvider>,
    ),
  };
}

describe('ManualAddForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('form validation', () => {
    it('shows validation error when title is empty on submit', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByText('Title is required')).toBeInTheDocument();
      });
      expect(api.addBook).not.toHaveBeenCalled();
    });

    it('shows validation error when title is whitespace-only on submit', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText(/title/i), '   ');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByText('Title is required')).toBeInTheDocument();
      });
      expect(api.addBook).not.toHaveBeenCalled();
    });

    it('rejects non-numeric series position', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Test Book');
      // Bypass type="number" browser guard by setting value directly via fireEvent
      const positionInput = screen.getByLabelText(/position/i);
      fireEvent.change(positionInput, { target: { value: 'abc' } });
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });
      expect(api.addBook).not.toHaveBeenCalled();
    });

    it('submits successfully with title only', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Shogun' });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Shogun',
          authors: [],
          searchImmediately: true,
        }));
      });
    });

    it('submits successfully with all fields populated', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Shogun' });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.type(screen.getByLabelText(/author/i), 'James Clavell');
      await user.type(screen.getByLabelText(/series$/i), 'Asian Saga');
      await user.type(screen.getByLabelText(/position/i), '1');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Shogun',
          authors: [{ name: 'James Clavell' }],
          seriesName: 'Asian Saga',
          seriesPosition: 1,
          searchImmediately: true,
        }));
      });
    });
  });

  describe('settings-driven behavior', () => {
    it('uses searchImmediately from quality settings', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Test' });
      (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: { searchImmediately: false, monitorForUpgrades: true },
      });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Test');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
          searchImmediately: false,
          monitorForUpgrades: true,
        }));
      });
    });
  });

  describe('pre-fill behavior', () => {
    it('pre-fills title from defaultTitle prop', () => {
      renderForm({ defaultTitle: 'Shogun' });
      expect(screen.getByLabelText(/title/i)).toHaveValue('Shogun');
    });

    it('renders empty title when no defaultTitle prop', () => {
      renderForm();
      expect(screen.getByLabelText(/title/i)).toHaveValue('');
    });
  });

  describe('mutation lifecycle', () => {
    it('shows success toast after successful add', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Shogun' });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Added 'Shogun' to library");
      });
    });

    it('invalidates books query after successful add', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Shogun' });
      const { queryClient } = renderForm();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
    });

    it('shows error toast when API returns error', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to add book: Network error');
      });
    });

    it('calls onSuccess callback after successful add', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Shogun' });
      renderForm({ onSuccess });

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalled();
      });
    });
  });
});
