import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualAddForm } from './ManualAddForm';
import { api, ApiError } from '@/lib/api';
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

function renderForm(props: { defaultTitle?: string; onSuccess?: () => void; onPendingChange?: (pending: boolean) => void } = {}) {
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
      // fireEvent bypasses the number input's browser validation.
      const positionInput = screen.getByLabelText(/position/i);
      fireEvent.change(positionInput, { target: { value: 'abc' } });
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });
      expect(api.addBook).not.toHaveBeenCalled();
    });

    it('treats whitespace-only series position as empty, not as 0', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Test' });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Test Book');
      const positionInput = screen.getByLabelText(/position/i);
      fireEvent.change(positionInput, { target: { value: '   ' } });
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalled();
      });
      // exactOptionalPropertyTypes requires omission rather than explicit undefined.
      const payload = (api.addBook as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(payload).not.toHaveProperty('seriesPosition');
    });

    it('converts series position "0" to number 0, not undefined', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Test' });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Test Book');
      const positionInput = screen.getByLabelText(/position/i);
      fireEvent.change(positionInput, { target: { value: '0' } });
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
          seriesPosition: 0,
        }));
      });
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
        quality: { searchImmediately: false },
      });
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Test');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
          searchImmediately: false,
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
      // A plain Error is not an ApiError, so no conflict verdict exists to act on.
      expect(toast.info).not.toHaveBeenCalled();
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

  // A 409 means nothing was created, and the form has no "Add anyway" control to offer — so it must
  // keep the operator's typed values instead of resetting and closing (#2212).
  describe('#2212 409 conflict branches', () => {
    async function submitAgainst(
      body: unknown,
      props: { onSuccess?: () => void; onPendingChange?: (pending: boolean) => void } = {},
    ) {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, body));
      const rendered = renderForm(props);
      const invalidateSpy = vi.spyOn(rendered.queryClient, 'invalidateQueries');

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      return { ...rendered, invalidateSpy };
    }

    /** The two branches are mutually exclusive: a review must not also make the ownership claim. */
    function expectNoOwnershipClaim(invalidateSpy: ReturnType<typeof vi.spyOn>) {
      expect(toast.info).not.toHaveBeenCalledWith('Already in library');
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.books() });
    }

    it('shows the review copy and keeps the typed values on a review 409', async () => {
      const onSuccess = vi.fn();
      const { invalidateSpy } = await submitAgainst({ conflict: 'review', id: 88, title: 'Piranesi' }, { onSuccess });

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith(
          "Possible duplicate (review): may be the same recording as 'Piranesi'",
        );
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/title/i)).toHaveValue('Shogun');
      expect(toast.error).not.toHaveBeenCalled();
      expectNoOwnershipClaim(invalidateSpy);
    });

    it('falls back to the generic review copy when the 409 body carries no title', async () => {
      const { invalidateSpy } = await submitAgainst({ conflict: 'review', id: 3 });

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith(
          'Possible duplicate (review): may be the same recording as a book already in your library',
        );
      });
      expect(toast.error).not.toHaveBeenCalled();
      expectNoOwnershipClaim(invalidateSpy);
    });

    it.each([
      ['same-recording', { conflict: 'same-recording', id: 7, title: 'Owned' }],
      ['owned-race', { conflict: 'owned-race', id: 7, title: 'Owned' }],
      ['an absent discriminator', { id: 7, title: 'Owned' }],
      ['an unrecognized discriminator', { conflict: 'bogus' }],
      ['a null body', null],
      ['an array body', []],
    ])('claims ownership and refreshes the library for %s', async (_label, body) => {
      const onSuccess = vi.fn();
      const { queryClient } = renderForm({ onSuccess });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, body));

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith('Already in library');
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/title/i)).toHaveValue('Shogun');
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('keeps the failure copy for a non-409 ApiError', async () => {
      const user = userEvent.setup();
      (api.addBook as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(500, null));
      renderForm();

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to add book: HTTP 500');
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    // The modal's close guard tracks isPending, so a held add must still leave the form closable.
    it('re-enables the submit button and reports not-pending after a 409 settles', async () => {
      const onPendingChange = vi.fn();
      const user = userEvent.setup();
      let rejectAdd!: (reason: unknown) => void;
      (api.addBook as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((_resolve, reject) => { rejectAdd = reject; }),
      );
      renderForm({ onPendingChange });

      await user.type(screen.getByLabelText(/title/i), 'Shogun');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(onPendingChange).toHaveBeenCalledWith(true);
      });

      rejectAdd(new ApiError(409, { conflict: 'review', id: 88, title: 'Piranesi' }));

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
      });

      const submit = screen.getByRole('button', { name: /add book/i });
      expect(submit).toBeEnabled();
      expect(submit).toHaveTextContent('Add Book');
    });
  });

  describe('#296 onPendingChange callback', () => {
    it('calls onPendingChange with true when mutation starts and false when it completes', async () => {
      const user = userEvent.setup();
      const onPendingChange = vi.fn();
      let resolveAdd!: (value: unknown) => void;
      (api.addBook as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => { resolveAdd = resolve; }),
      );
      renderForm({ onPendingChange });

      await user.type(screen.getByLabelText(/title/i), 'Test');
      await user.click(screen.getByRole('button', { name: /add book/i }));

      await waitFor(() => {
        expect(onPendingChange).toHaveBeenCalledWith(true);
      });

      resolveAdd({ id: 1, title: 'Test' });

      await waitFor(() => {
        expect(onPendingChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('AC4 — aria-labelledby', () => {
    it('heading has an id attribute for aria-labelledby reference', () => {
      renderForm();

      const heading = screen.getByRole('heading', { name: 'Add manually' });
      expect(heading.id).toBe('manual-add-form-title');
    });
  });
});
