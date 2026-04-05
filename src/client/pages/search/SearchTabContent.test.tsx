import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BooksTabContent, AuthorsTabContent } from './SearchTabContent';
import { createMockBookMetadata, createMockAuthorMetadata } from '@/__tests__/factories';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

let mockedApi: { addBook: ReturnType<typeof vi.fn>; getSettings: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const { api } = await import('@/lib/api');
  mockedApi = api as unknown as typeof mockedApi;
  mockedApi.addBook.mockReset();
  mockedApi.getSettings.mockResolvedValue({});
});

function renderBooksTab(books = [createMockBookMetadata()], searchTerm?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BooksTabContent books={books} libraryBooks={undefined} queryClient={queryClient} searchTerm={searchTerm} />
    </QueryClientProvider>,
  );
}

function getModal() {
  return document.querySelector('[data-testid="modal-backdrop"]')?.closest('[class*="fixed inset-0"]') ?? null;
}

describe('BooksTabContent', () => {
  it('renders empty state when books array is empty', () => {
    renderBooksTab([]);
    expect(screen.getByText('No books found')).toBeInTheDocument();
  });

  it('renders "Add manually" CTA button in empty state (#246)', () => {
    renderBooksTab([]);
    expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();
    // Modal should NOT be open until CTA is clicked
    expect(getModal()).toBeNull();
  });

  it('opens modal with pre-filled title on CTA click in empty state (#246)', async () => {
    const user = userEvent.setup();
    renderBooksTab([], 'Obscure Book');

    await user.click(screen.getByRole('button', { name: /add manually/i }));

    expect(getModal()).not.toBeNull();
    expect(screen.getByLabelText(/title/i)).toHaveValue('Obscure Book');
  });

  it('closes modal after successful submit in empty state (#246)', async () => {
    const user = userEvent.setup();
    mockedApi.addBook.mockResolvedValue({ id: 1, title: 'Test' });
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test Book');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    // After success, modal should close
    await waitFor(() => {
      expect(getModal()).toBeNull();
    });
    // CTA button should still be there
    expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();
  });

  it('shows "Can\'t find it?" link below results that opens modal (#246)', async () => {
    const user = userEvent.setup();
    renderBooksTab([createMockBookMetadata()]);

    const toggle = screen.getByText(/can.*t find it/i);
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(getModal()).not.toBeNull();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
  });

  it('renders SearchBookCard for each book', () => {
    const books = [
      createMockBookMetadata({ title: 'Book One' }),
      createMockBookMetadata({ title: 'Book Two', asin: 'B00OTHER' }),
    ];
    renderBooksTab(books);
    expect(screen.getByText('Book One')).toBeInTheDocument();
    expect(screen.getByText('Book Two')).toBeInTheDocument();
  });

  it('exact title match is promoted to first position', () => {
    const books = [
      createMockBookMetadata({ title: 'A Court of Thorns and Roses 7', asin: 'B007' }),
      createMockBookMetadata({ title: 'A Court of Thorns and Roses 6', asin: 'B006' }),
      createMockBookMetadata({ title: 'A Court of Thorns and Roses', asin: 'B001' }),
    ];
    renderBooksTab(books, 'A Court of Thorns and Roses');
    const cards = screen.getAllByText(/A Court of Thorns and Roses/);
    expect(cards[0].textContent).toBe('A Court of Thorns and Roses');
  });

  it('exact title match is case-insensitive', () => {
    const books = [
      createMockBookMetadata({ title: 'Other Book', asin: 'B002' }),
      createMockBookMetadata({ title: 'The Shining', asin: 'B001' }),
    ];
    renderBooksTab(books, 'the shining');
    const cards = screen.getAllByText(/The Shining|Other Book/);
    expect(cards[0].textContent).toBe('The Shining');
  });

  it('preserves API order when no exact match exists', () => {
    const books = [
      createMockBookMetadata({ title: 'Book B', asin: 'B002' }),
      createMockBookMetadata({ title: 'Book A', asin: 'B001' }),
    ];
    renderBooksTab(books, 'something else');
    const cards = screen.getAllByText(/Book [AB]/);
    expect(cards[0].textContent).toBe('Book B');
    expect(cards[1].textContent).toBe('Book A');
  });
});

describe('AuthorsTabContent', () => {
  it('renders empty state when authors array is empty', () => {
    render(<AuthorsTabContent authors={[]} />);
    expect(screen.getByText('No authors found')).toBeInTheDocument();
  });

  it('renders SearchAuthorCard for each author', () => {
    const authors = [
      createMockAuthorMetadata({ name: 'Author One' }),
      createMockAuthorMetadata({ name: 'Author Two', asin: 'B00OTHER' }),
    ];
    render(<AuthorsTabContent authors={authors} />);
    expect(screen.getByText('Author One')).toBeInTheDocument();
    expect(screen.getByText('Author Two')).toBeInTheDocument();
  });
});

describe('#296 modal behavior', () => {
  it('clicking "Add manually" button in empty state opens a modal', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));

    expect(getModal()).not.toBeNull();
    expect(screen.getByText('Add manually', { selector: 'h3' })).toBeInTheDocument();
  });

  it('clicking "Can\'t find it?" link in results state opens a modal', async () => {
    const user = userEvent.setup();
    renderBooksTab([createMockBookMetadata()]);

    await user.click(screen.getByText(/can.*t find it/i));

    expect(getModal()).not.toBeNull();
    expect(screen.getByText('Add manually', { selector: 'h3' })).toBeInTheDocument();
  });

  it('modal contains Title, Author, Series, Position fields', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));

    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/author/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/series/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/position/i)).toBeInTheDocument();
  });

  it('submitting form in modal adds book and closes modal', async () => {
    const user = userEvent.setup();
    mockedApi.addBook.mockResolvedValue({ id: 1, title: 'My Book' });
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'My Book');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(getModal()).toBeNull();
    });
    expect(mockedApi.addBook).toHaveBeenCalledWith(expect.objectContaining({ title: 'My Book' }));
  });

  it('Escape closes modal without adding', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    expect(getModal()).not.toBeNull();

    await user.keyboard('{Escape}');

    expect(getModal()).toBeNull();
    expect(mockedApi.addBook).not.toHaveBeenCalled();
  });

  it('backdrop click does NOT close modal (closeOnBackdropClick={false})', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    expect(getModal()).not.toBeNull();

    const backdrop = screen.getByTestId('modal-backdrop');
    await user.click(backdrop);

    // Modal should still be open
    expect(getModal()).not.toBeNull();
  });

  it('modal is not visible before link is clicked', () => {
    renderBooksTab([]);
    expect(getModal()).toBeNull();
  });

  it('form resets between close and re-open (no stale values)', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    // Open, type something, close via Escape
    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Stale Value');
    await user.keyboard('{Escape}');

    // Re-open — title should be empty (form remounted)
    await user.click(screen.getByRole('button', { name: /add manually/i }));
    expect(screen.getByLabelText(/title/i)).toHaveValue('');
  });

  it('submit button disabled and shows "Adding..." while mutation is pending', async () => {
    const user = userEvent.setup();
    let resolveAdd!: (value: unknown) => void;
    mockedApi.addBook.mockImplementation(() => new Promise((resolve) => { resolveAdd = resolve; }));
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /adding/i })).toBeDisabled();
    });

    // Resolve to clean up
    resolveAdd({ id: 1, title: 'Test' });
    await waitFor(() => {
      expect(getModal()).toBeNull();
    });
  });

  it('Escape disabled while mutation is pending', async () => {
    const user = userEvent.setup();
    let resolveAdd!: (value: unknown) => void;
    mockedApi.addBook.mockImplementation(() => new Promise((resolve) => { resolveAdd = resolve; }));
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    // Wait for pending state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /adding/i })).toBeDisabled();
    });

    // Escape should NOT close modal while pending
    await user.keyboard('{Escape}');
    expect(getModal()).not.toBeNull();

    // Resolve to clean up
    resolveAdd({ id: 1, title: 'Test' });
    await waitFor(() => {
      expect(getModal()).toBeNull();
    });
  });

  it('empty state trigger prefills Title from search term', async () => {
    const user = userEvent.setup();
    renderBooksTab([], 'My Search');

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    expect(screen.getByLabelText(/title/i)).toHaveValue('My Search');
  });

  it('results state trigger leaves Title blank', async () => {
    const user = userEvent.setup();
    renderBooksTab([createMockBookMetadata()]);

    await user.click(screen.getByText(/can.*t find it/i));
    expect(screen.getByLabelText(/title/i)).toHaveValue('');
  });

  it('API rejection shows error toast, modal stays open for retry', async () => {
    const user = userEvent.setup();
    const { toast } = await import('sonner');
    mockedApi.addBook.mockRejectedValue(new Error('Server error'));
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add book: Server error');
    });
    // Modal stays open
    expect(getModal()).not.toBeNull();
  });

  it('Escape dismisses modal after API error', async () => {
    const user = userEvent.setup();
    mockedApi.addBook.mockRejectedValue(new Error('Server error'));
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    // Wait for error to surface
    await waitFor(() => {
      expect(getModal()).not.toBeNull();
    });

    // Escape should still work after error (not pending anymore)
    await user.keyboard('{Escape}');
    expect(getModal()).toBeNull();
  });

  it('validation error (empty title) keeps modal open with error message visible', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    // Don't type a title — submit immediately
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(screen.getByText('Title is required')).toBeInTheDocument();
    });
    // Modal stays open
    expect(getModal()).not.toBeNull();
    expect(mockedApi.addBook).not.toHaveBeenCalled();
  });

  it('Escape dismisses modal after validation error', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    // Submit without title to trigger validation
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(screen.getByText('Title is required')).toBeInTheDocument();
    });

    // Escape should still work after validation error
    await user.keyboard('{Escape}');
    expect(getModal()).toBeNull();
  });

  it('close button closes modal', async () => {
    const user = userEvent.setup();
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    expect(getModal()).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(getModal()).toBeNull();
    expect(mockedApi.addBook).not.toHaveBeenCalled();
  });

  it('close button disabled while mutation is pending', async () => {
    const user = userEvent.setup();
    let resolveAdd!: (value: unknown) => void;
    mockedApi.addBook.mockImplementation(() => new Promise((resolve) => { resolveAdd = resolve; }));
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /close/i })).toBeDisabled();
    });

    // Resolve to clean up
    resolveAdd({ id: 1, title: 'Test' });
    await waitFor(() => {
      expect(getModal()).toBeNull();
    });
  });
});

describe('Stable keys — duplicate data handling', () => {
  it('renders two books with the same asin independently', () => {
    const books = [
      createMockBookMetadata({ title: 'Book A', asin: 'SAME_ASIN', providerId: 'prov1' }),
      createMockBookMetadata({ title: 'Book B', asin: 'SAME_ASIN', providerId: 'prov2' }),
    ];
    renderBooksTab(books);
    expect(screen.getByText('Book A')).toBeInTheDocument();
    expect(screen.getByText('Book B')).toBeInTheDocument();
  });

  it('renders true duplicate books without React duplicate-key warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const books = [
      createMockBookMetadata({ title: 'Same Book', asin: 'SAME', providerId: 'prov1' }),
      createMockBookMetadata({ title: 'Same Book', asin: 'SAME', providerId: 'prov1' }),
    ];
    renderBooksTab(books);
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything(), expect.anything());
    spy.mockRestore();
  });

  it('renders two authors with the same name independently', () => {
    const authors = [
      createMockAuthorMetadata({ name: 'Same Author', imageUrl: 'img1.jpg' }),
      createMockAuthorMetadata({ name: 'Same Author', imageUrl: 'img2.jpg' }),
    ];
    render(<AuthorsTabContent authors={authors} />);
    expect(screen.getAllByText('Same Author')).toHaveLength(2);
  });

  it('renders true duplicate authors without React duplicate-key warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const authors = [
      createMockAuthorMetadata({ name: 'Same', imageUrl: 'same.jpg' }),
      createMockAuthorMetadata({ name: 'Same', imageUrl: 'same.jpg' }),
    ];
    render(<AuthorsTabContent authors={authors} />);
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything(), expect.anything());
    spy.mockRestore();
  });
});
