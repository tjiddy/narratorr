import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers.js';
import { createMockBook } from '../../__tests__/factories.js';
import { LibraryTableView } from './LibraryTableView.js';
import type { SortField, SortDirection, DisplayBook } from './helpers.js';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    formatBytes: (bytes?: number) => {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    },
  };
});

// #282 — Library table view component tests

function defaultProps() {
  return {
    books: [createMockBook()],
    selectedIds: new Set<number>(),
    onSelectionChange: vi.fn(),
    sortField: 'createdAt' as SortField,
    sortDirection: 'desc' as SortDirection,
    onSortFieldChange: vi.fn(),
    onSortDirectionChange: vi.fn(),
  };
}

function renderTable(overrides: Partial<ReturnType<typeof defaultProps>> = {}) {
  const props = { ...defaultProps(), ...overrides };
  return {
    ...props,
    ...renderWithProviders(
      <LibraryTableView {...props} />,
    ),
  };
}

describe('LibraryTableView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('column rendering', () => {
    it('renders all expected columns: status, title, author, narrator, series, date added, quality, size, format', () => {
      renderTable();
      const headers = screen.getAllByRole('columnheader');
      const headerTexts = headers.map((h) => h.textContent?.trim().toLowerCase());
      expect(headerTexts).toContain('title');
      expect(headerTexts).toContain('author');
      expect(headerTexts).toContain('narrator');
      expect(headerTexts).toContain('series');
      expect(headerTexts).toContain('status');
      expect(headerTexts).toContain('quality');
      expect(headerTexts).toContain('size');
      expect(headerTexts).toContain('format');
      expect(headerTexts).toContain('date added');
    });

    it('does not render a duration column', () => {
      renderTable();
      const headers = screen.getAllByRole('columnheader');
      const headerTexts = headers.map((h) => h.textContent?.trim().toLowerCase());
      expect(headerTexts).not.toContain('duration');
    });

    it('renders book data in each column correctly', () => {
      const book = createMockBook({
        id: 42,
        title: 'Mistborn',
        narrators: [{ id: 1, name: 'Michael Kramer', slug: 'michael-kramer' }],
        seriesName: 'Cosmere',
        seriesPosition: 1,
        status: 'imported',
        audioTotalSize: 500 * 1024 * 1024, // 500 MB
        audioDuration: 36000, // 10 hours
        audioFileFormat: 'mp3',
        createdAt: '2024-06-15T00:00:00Z',
      });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      // First row is header, second is data
      const dataRow = rows[1];
      const cells = within(dataRow!).getAllByRole('cell');

      // Status cell (index 1, after checkbox)
      expect(cells[1]).toHaveTextContent('imported');
      // Title cell
      expect(cells[2]).toHaveTextContent('Mistborn');
      // Author cell
      expect(cells[3]).toHaveTextContent('Brandon Sanderson');
      // Narrator cell
      expect(cells[4]).toHaveTextContent('Michael Kramer');
      // Series cell
      expect(cells[5]).toHaveTextContent('Cosmere #1');
      // Date Added cell — formatted via toLocaleDateString, timezone may shift the day
      expect(cells[6]!.textContent).toMatch(/Jun.*1[45].*2024/);
      // Quality cell (MB/hr): 500 MB / 10 hours = 50 MB/hr
      expect(cells[7]).toHaveTextContent('50 MB/hr');
      // Size cell
      expect(cells[8]).toHaveTextContent('500 MB');
      // Format cell
      expect(cells[9]).toHaveTextContent('mp3');
    });

    it('shows dash for null narrator', () => {
      const book = createMockBook({ narrators: [] });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[4]).toHaveTextContent('—');
    });

    it('shows dash for null series', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: null });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[5]).toHaveTextContent('—');
    });

    it('shows dash for null quality (no audioDuration)', () => {
      const book = createMockBook({ audioDuration: null, duration: null });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[7]).toHaveTextContent('—');
    });

    it('shows dash for null format', () => {
      const book = createMockBook({ audioFileFormat: null });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[9]).toHaveTextContent('—');
    });

    it('shows dash for null size (both audioTotalSize and size null)', () => {
      const book = createMockBook({ audioTotalSize: null, size: null });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[8]).toHaveTextContent('—');
    });

    it('falls back from audioTotalSize to size for size column', () => {
      const book = createMockBook({
        audioTotalSize: null,
        size: 200 * 1024 * 1024, // 200 MB
      });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[8]).toHaveTextContent('200 MB');
    });

    it('computes MB/hr from audioTotalSize and audioDuration', () => {
      // 1 GB over 5 hours = 204.8 MB/hr, rounds to 205
      const book = createMockBook({
        audioTotalSize: 1024 * 1024 * 1024,
        audioDuration: 18000, // 5 hours in seconds
      });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      expect(cells[7]).toHaveTextContent('205 MB/hr');
    });

    it('guards against division by zero when audioDuration is 0', () => {
      const book = createMockBook({
        audioTotalSize: 500 * 1024 * 1024,
        audioDuration: 0,
        duration: 0,
      });
      renderTable({ books: [book] });

      const rows = screen.getAllByRole('row');
      const cells = within(rows[1]!).getAllByRole('cell');
      // computeMbPerHour returns null when duration <= 0, so dash is shown
      expect(cells[7]).toHaveTextContent('—');
    });
  });

  describe('sorting', () => {
    it('renders books in the order provided (ascending)', () => {
      const books = [
        createMockBook({ id: 1, title: 'Alpha' }),
        createMockBook({ id: 2, title: 'Beta' }),
        createMockBook({ id: 3, title: 'Gamma' }),
      ];
      renderTable({ books });

      const rows = screen.getAllByRole('row').slice(1); // skip header
      expect(rows[0]).toHaveTextContent('Alpha');
      expect(rows[1]).toHaveTextContent('Beta');
      expect(rows[2]).toHaveTextContent('Gamma');
    });

    it('column headers are clickable sort controls', () => {
      renderTable();
      const sortButtons = screen.getAllByRole('button', { name: /sort by/i });
      expect(sortButtons.length).toBeGreaterThan(0);
      // All sortable columns should have buttons
      expect(screen.getByRole('button', { name: 'Sort by Title' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Author' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Narrator' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Series' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Date Added' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Quality' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Size' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort by Format' })).toBeInTheDocument();
    });

    it('clicking an inactive column header calls onSortFieldChange', async () => {
      const user = userEvent.setup();
      const { onSortFieldChange } = renderTable({ sortField: 'createdAt' });

      await user.click(screen.getByRole('button', { name: 'Sort by Title' }));

      expect(onSortFieldChange).toHaveBeenCalledWith('title');
    });

    it('clicking the active column header toggles sort direction', async () => {
      const user = userEvent.setup();
      const { onSortDirectionChange } = renderTable({ sortField: 'title', sortDirection: 'asc' });

      await user.click(screen.getByRole('button', { name: 'Sort by Title' }));

      expect(onSortDirectionChange).toHaveBeenCalledWith('desc');
    });

    it('clicking active column header toggles desc to asc', async () => {
      const user = userEvent.setup();
      const { onSortDirectionChange } = renderTable({ sortField: 'title', sortDirection: 'desc' });

      await user.click(screen.getByRole('button', { name: 'Sort by Title' }));

      expect(onSortDirectionChange).toHaveBeenCalledWith('asc');
    });
  });

  describe('selection', () => {
    it('renders checkbox in each row', () => {
      const books = [
        createMockBook({ id: 1, title: 'Book A' }),
        createMockBook({ id: 2, title: 'Book B' }),
      ];
      renderTable({ books });

      const checkboxes = screen.getAllByRole('checkbox');
      // 1 select-all + 2 row checkboxes
      expect(checkboxes).toHaveLength(3);
      expect(screen.getByLabelText('Select Book A')).toBeInTheDocument();
      expect(screen.getByLabelText('Select Book B')).toBeInTheDocument();
    });

    it('select all checkbox selects all visible rows', async () => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      const books = [
        createMockBook({ id: 10, title: 'Book A' }),
        createMockBook({ id: 20, title: 'Book B' }),
      ];
      renderTable({ books, selectedIds: new Set(), onSelectionChange });

      const selectAll = screen.getByLabelText('Select all books');
      await user.click(selectAll);

      expect(onSelectionChange).toHaveBeenCalledWith(new Set([10, 20]));
    });

    it('individual checkbox toggles row selection', async () => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      const books = [
        createMockBook({ id: 10, title: 'Book A' }),
        createMockBook({ id: 20, title: 'Book B' }),
      ];
      renderTable({ books, selectedIds: new Set(), onSelectionChange });

      const bookACheckbox = screen.getByLabelText('Select Book A');
      await user.click(bookACheckbox);

      expect(onSelectionChange).toHaveBeenCalledWith(new Set([10]));
    });

    it('calls onSelectionChange with all ids when select-all is clicked', async () => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      const books = [
        createMockBook({ id: 1 }),
        createMockBook({ id: 2 }),
        createMockBook({ id: 3 }),
      ];
      renderTable({ books, selectedIds: new Set(), onSelectionChange });

      await user.click(screen.getByLabelText('Select all books'));
      expect(onSelectionChange).toHaveBeenCalledWith(new Set([1, 2, 3]));
    });

    it('calls onSelectionChange with empty set when deselecting all', async () => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      const books = [
        createMockBook({ id: 1 }),
        createMockBook({ id: 2 }),
      ];
      // Start with all selected
      renderTable({ books, selectedIds: new Set([1, 2]), onSelectionChange });

      await user.click(screen.getByLabelText('Select all books'));
      expect(onSelectionChange).toHaveBeenCalledWith(new Set());
    });
  });

  describe('empty state', () => {
    it('renders nothing when zero books', () => {
      const { container } = renderTable({ books: [] });
      // Component returns null for empty books array
      expect(container.querySelector('table')).toBeNull();
    });
  });

  describe('collapsed series badge', () => {
    it('shows total book count when collapsedCount > 0', () => {
      const book: DisplayBook = { ...createMockBook(), collapsedCount: 4 };
      renderTable({ books: [book] });
      expect(screen.getByText('5 books')).toBeInTheDocument();
    });

    it('does not render badge when collapsedCount is 0', () => {
      const book: DisplayBook = { ...createMockBook(), collapsedCount: 0 };
      renderTable({ books: [book] });
      expect(screen.queryByText(/books$/)).not.toBeInTheDocument();
    });

    it('does not render badge when collapsedCount is undefined', () => {
      renderTable({ books: [createMockBook()] });
      expect(screen.queryByText(/books$/)).not.toBeInTheDocument();
    });
  });
});
