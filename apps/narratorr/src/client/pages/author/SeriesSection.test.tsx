import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeriesSection } from './SeriesSection';
import { createMockBookMetadata, createMockBook } from '@/__tests__/factories';

const defaultProps = {
  name: 'The Stormlight Archive',
  onAddBook: vi.fn(),
  onAddAll: vi.fn(),
  addingAsins: new Set<string>(),
  isAddingAll: false,
};

describe('SeriesSection', () => {
  it('renders series name and book count', () => {
    const books = [createMockBookMetadata(), createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' })];
    render(<SeriesSection {...defaultProps} books={books} />);
    expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    expect(screen.getByText('2 books')).toBeInTheDocument();
  });

  it('shows singular "book" for single book', () => {
    render(<SeriesSection {...defaultProps} books={[createMockBookMetadata()]} />);
    expect(screen.getByText('1 book')).toBeInTheDocument();
  });

  it('shows plural "books" for multiple books', () => {
    const books = [createMockBookMetadata(), createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' })];
    render(<SeriesSection {...defaultProps} books={books} />);
    expect(screen.getByText('2 books')).toBeInTheDocument();
  });

  it('shows Add All button when not all books in library', () => {
    render(<SeriesSection {...defaultProps} books={[createMockBookMetadata()]} />);
    expect(screen.getByText(/Add All/)).toBeInTheDocument();
  });

  it('hides Add All button when all books in library', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [createMockBook({ asin: book.asin })];
    render(<SeriesSection {...defaultProps} books={[book]} libraryBooks={libraryBooks} />);
    expect(screen.queryByText(/Add All/)).not.toBeInTheDocument();
  });

  it('shows count of books not in library in Add All button', () => {
    const book1 = createMockBookMetadata();
    const book2 = createMockBookMetadata({ title: 'Words of Radiance', asin: 'B00DA6YEKS' });
    const libraryBooks = [createMockBook({ asin: book1.asin })];
    render(<SeriesSection {...defaultProps} books={[book1, book2]} libraryBooks={libraryBooks} />);
    expect(screen.getByText(/Add All \(1\)/)).toBeInTheDocument();
  });

  it('disables Add All button during isAddingAll', () => {
    render(<SeriesSection {...defaultProps} books={[createMockBookMetadata()]} isAddingAll={true} />);
    const button = screen.getByText(/Add All/).closest('button');
    expect(button).toBeDisabled();
  });

  it('calls onAddAll when Add All is clicked', async () => {
    const onAddAll = vi.fn();
    const user = userEvent.setup();
    render(<SeriesSection {...defaultProps} books={[createMockBookMetadata()]} onAddAll={onAddAll} />);

    await user.click(screen.getByText(/Add All/).closest('button')!);
    expect(onAddAll).toHaveBeenCalledTimes(1);
  });

  it('renders BookRow for each book', () => {
    const books = [
      createMockBookMetadata({ title: 'Book One' }),
      createMockBookMetadata({ title: 'Book Two', asin: 'B00OTHER' }),
    ];
    render(<SeriesSection {...defaultProps} books={books} />);
    expect(screen.getByText('Book One')).toBeInTheDocument();
    expect(screen.getByText('Book Two')).toBeInTheDocument();
  });
});
