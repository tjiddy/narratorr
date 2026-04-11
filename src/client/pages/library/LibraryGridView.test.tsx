import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryGridView } from './LibraryGridView';
import type { LibraryGridViewProps } from './LibraryGridView';
import type { DisplayBook } from './helpers';

function makeBook(overrides: Partial<DisplayBook> = {}): DisplayBook {
  return {
    id: 1,
    title: 'Test Book',
    authorName: 'Author Name',
    authors: [{ name: 'Author Name' }],
    narrators: [],
    status: 'imported',
    path: '/audiobooks/test',
    audioFileCount: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as DisplayBook;
}

function defaultProps(overrides: Partial<LibraryGridViewProps> = {}): LibraryGridViewProps {
  return {
    displayBooks: [],
    settledGridKey: 'createdAt-desc',
    openMenuId: null,
    onMenuToggle: vi.fn(),
    onMenuClose: vi.fn(),
    onClick: vi.fn(),
    onSearchReleases: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

describe('LibraryGridView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders book cards with correct data for each book', () => {
    const books = [makeBook({ id: 1, title: 'Book One' }), makeBook({ id: 2, title: 'Book Two' })];
    renderWithProviders(<LibraryGridView {...defaultProps({ displayBooks: books })} />);
    expect(screen.getByText('Book One')).toBeInTheDocument();
    expect(screen.getByText('Book Two')).toBeInTheDocument();
  });

  it('renders responsive grid layout', () => {
    const books = [makeBook({ id: 1 })];
    const { container } = renderWithProviders(<LibraryGridView {...defaultProps({ displayBooks: books })} />);
    const grid = container.querySelector('.grid');
    expect(grid).toBeInTheDocument();
    expect(grid?.className).toContain('grid-cols-2');
    expect(grid?.className).toContain('sm:grid-cols-3');
  });

  it('renders empty when displayBooks is empty', () => {
    const { container } = renderWithProviders(<LibraryGridView {...defaultProps()} />);
    const grid = container.querySelector('.grid');
    expect(grid).toBeInTheDocument();
    expect(grid?.children.length).toBe(0);
  });
});
