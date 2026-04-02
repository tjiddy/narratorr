import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualAddFormModal } from './ManualAddFormModal';

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

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('ManualAddFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC4 — aria-labelledby', () => {
    it('dialog element has aria-labelledby attribute referencing the form heading', () => {
      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={vi.fn()} />,
      );

      const dialog = screen.getByRole('dialog');
      const labelledById = dialog.getAttribute('aria-labelledby');
      expect(labelledById).toBeTruthy();

      const heading = document.getElementById(labelledById!);
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toBe('Add manually');
    });

    it('heading text matches expected title', () => {
      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={vi.fn()} />,
      );

      const heading = screen.getByRole('heading', { name: 'Add manually' });
      expect(heading).toBeInTheDocument();
      expect(heading.id).toBeTruthy();
    });
  });

  describe('close button guard', () => {
    it('does not call onClose when close button is clicked while form is pending', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      // Mock addBook to never resolve — keeps mutation in pending state
      const { api } = await import('@/lib/api');
      vi.mocked(api.addBook).mockReturnValue(new Promise(() => {}));

      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );

      // Fill required field and submit to trigger pending state
      const titleInput = screen.getByPlaceholderText('Book title');
      await user.type(titleInput, 'Test Book');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      // Wait for the close button to become disabled (pending state propagated)
      await waitFor(() => {
        expect(screen.getByLabelText('Close')).toBeDisabled();
      });

      // Use fireEvent to bypass disabled attribute — tests the onClick guard directly
      fireEvent.click(screen.getByLabelText('Close'));

      expect(onClose).not.toHaveBeenCalled();
    });

    it('calls onClose when close button is clicked while not pending', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );

      await user.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
