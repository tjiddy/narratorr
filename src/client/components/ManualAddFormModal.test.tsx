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
        quality: { searchImmediately: true },
      }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
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

      // Hold the mutation in its pending state.
      const { api } = await import('@/lib/api');
      vi.mocked(api.addBook).mockReturnValue(new Promise(() => {}));

      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );

      const titleInput = screen.getByPlaceholderText('Book title');
      await user.type(titleInput, 'Test Book');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByLabelText('Close')).toBeDisabled();
      });

      // fireEvent bypasses disabled so the handler guard is exercised directly.
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

  // Nothing was created and the modal offers no "Add anyway" control, so a held add leaves the
  // operator with their typed values and the choice to close (#2212).
  describe('#2212 a review 409 leaves the modal open and closable', () => {
    it('keeps the modal mounted with its typed values and re-enables closing', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const { api, ApiError } = await import('@/lib/api');
      const { toast } = await import('sonner');
      vi.mocked(api.addBook).mockRejectedValue(
        new ApiError(409, { conflict: 'review', id: 88, title: 'Piranesi' }),
      );

      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );

      await user.type(screen.getByPlaceholderText('Book title'), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith(
          "Possible duplicate (review): may be the same recording as 'Piranesi'",
        );
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Book title')).toHaveValue('Shogun');
      expect(screen.getByLabelText('Close')).toBeEnabled();

      await user.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Escape key (#484)', () => {
    it('calls onClose when Escape is pressed while open and not pending', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not call onClose when Escape is pressed while closed', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithQuery(
        <ManualAddFormModal isOpen={false} onClose={onClose} />,
      );
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not call onClose when Escape is pressed while form is pending', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();

      const { api } = await import('@/lib/api');
      vi.mocked(api.addBook).mockReturnValue(new Promise(() => {}));

      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={onClose} />,
      );

      const titleInput = screen.getByPlaceholderText('Book title');
      await user.type(titleInput, 'Test Book');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByLabelText('Close')).toBeDisabled();
      });

      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
