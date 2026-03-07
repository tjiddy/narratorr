import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function renderBooksTab(books = [createMockBookMetadata()]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BooksTabContent books={books} libraryBooks={undefined} queryClient={queryClient} />
    </QueryClientProvider>,
  );
}

describe('BooksTabContent', () => {
  it('renders empty state when books array is empty', () => {
    renderBooksTab([]);
    expect(screen.getByText('No books found')).toBeInTheDocument();
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
