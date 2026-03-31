import { describe, it, expect, vi } from 'vitest';
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

function renderBooksTab(books = [createMockBookMetadata()], searchTerm?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BooksTabContent books={books} libraryBooks={undefined} queryClient={queryClient} searchTerm={searchTerm} />
    </QueryClientProvider>,
  );
}

describe('BooksTabContent', () => {
  it('renders empty state when books array is empty', () => {
    renderBooksTab([]);
    expect(screen.getByText('No books found')).toBeInTheDocument();
  });

  it('renders "Add manually" CTA button in empty state (#246)', () => {
    renderBooksTab([]);
    expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();
    // Form should NOT be visible until CTA is clicked
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('opens form with pre-filled title on CTA click in empty state (#246)', async () => {
    const user = userEvent.setup();
    renderBooksTab([], 'Obscure Book');

    await user.click(screen.getByRole('button', { name: /add manually/i }));

    expect(screen.getByLabelText(/title/i)).toHaveValue('Obscure Book');
  });

  it('closes form after successful submit in empty state (#246)', async () => {
    const user = userEvent.setup();
    const { api: mockedApi } = await import('@/lib/api');
    (mockedApi.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, title: 'Test' });
    renderBooksTab([]);

    await user.click(screen.getByRole('button', { name: /add manually/i }));
    await user.type(screen.getByLabelText(/title/i), 'Test Book');
    await user.click(screen.getByRole('button', { name: /add book/i }));

    // After success, form should close and CTA should reappear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('shows "Can\'t find it?" toggle below results that reveals form (#246)', async () => {
    const user = userEvent.setup();
    renderBooksTab([createMockBookMetadata()]);

    const toggle = screen.getByText(/can.*t find it/i);
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
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
