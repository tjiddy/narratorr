import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeriesSection } from './SeriesSection';
import { createMockBookMetadata, createMockBook } from '@/__tests__/factories';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({
      quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: '', requiredWords: '' },
    }),
  },
}));

const defaultProps = {
  name: 'The Stormlight Archive',
  onAddBook: vi.fn(),
  onAddAll: vi.fn(),
  addingAsins: new Set<string>(),
  isAddingAll: false,
};

function renderSection(props: Partial<typeof defaultProps> & { books?: ReturnType<typeof createMockBookMetadata>[]; libraryBooks?: ReturnType<typeof createMockBook>[] } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { books = [createMockBookMetadata()], libraryBooks, ...rest } = props;
  return render(
    <QueryClientProvider client={queryClient}>
      <SeriesSection {...defaultProps} {...rest} books={books} {...(libraryBooks !== undefined && { libraryBooks })} />
    </QueryClientProvider>,
  );
}

describe('SeriesSection', () => {
  it('renders series name and book count', () => {
    const books = [createMockBookMetadata(), createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' })];
    renderSection({ books });
    expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    expect(screen.getByText('2 books')).toBeInTheDocument();
  });

  it('shows singular "book" for single book', () => {
    renderSection();
    expect(screen.getByText('1 book')).toBeInTheDocument();
  });

  it('shows plural "books" for multiple books', () => {
    const books = [createMockBookMetadata(), createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' })];
    renderSection({ books });
    expect(screen.getByText('2 books')).toBeInTheDocument();
  });

  it('shows Add All button when not all books in library', () => {
    renderSection();
    expect(screen.getByText(/Add All/)).toBeInTheDocument();
  });

  it('hides Add All button when all books in library', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [createMockBook(book.asin !== undefined ? { asin: book.asin } : {})];
    renderSection({ books: [book], libraryBooks });
    expect(screen.queryByText(/Add All/)).not.toBeInTheDocument();
  });

  it('shows count of books not in library in Add All button', () => {
    const book1 = createMockBookMetadata();
    const book2 = createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' });
    const libraryBooks = [createMockBook(book1.asin !== undefined ? { asin: book1.asin } : {})];
    renderSection({ books: [book1, book2], libraryBooks });
    expect(screen.getByText(/Add All \(1\)/)).toBeInTheDocument();
  });

  it('disables Add All button during isAddingAll', () => {
    renderSection({ isAddingAll: true });
    const button = screen.getByText(/Add All/).closest('button');
    expect(button).toBeDisabled();
  });

  it('calls onAddAll when Add All is clicked', async () => {
    const onAddAll = vi.fn();
    const user = userEvent.setup();
    renderSection({ onAddAll });

    await user.click(screen.getByText(/Add All/).closest('button')!);
    expect(onAddAll).toHaveBeenCalledTimes(1);
  });

  it('renders BookRow for each book', () => {
    const books = [
      createMockBookMetadata({ title: 'Book One' }),
      createMockBookMetadata({ title: 'Book Two', asin: 'B00OTHER' }),
    ];
    renderSection({ books });
    expect(screen.getByText('Book One')).toBeInTheDocument();
    expect(screen.getByText('Book Two')).toBeInTheDocument();
  });
});
