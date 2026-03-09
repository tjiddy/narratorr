import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryToolbar } from './LibraryToolbar';
import type { StatusFilter } from './helpers';

function defaultProps(overrides = {}) {
  return {
    searchQuery: '',
    onSearchChange: vi.fn(),
    onSearchClear: vi.fn(),
    statusFilter: 'all' as StatusFilter,
    onStatusFilterChange: vi.fn(),
    statusCounts: { all: 25, wanted: 10, downloading: 3, imported: 12 } as Record<StatusFilter, number>,
    filtersOpen: false,
    onFiltersToggle: vi.fn(),
    activeFilterCount: 0,
    authorFilter: '',
    onAuthorFilterChange: vi.fn(),
    uniqueAuthors: ['Author A', 'Author B'],
    seriesFilter: '',
    onSeriesFilterChange: vi.fn(),
    uniqueSeries: ['Series A'],
    sortField: 'createdAt' as const,
    onSortFieldChange: vi.fn(),
    sortDirection: 'desc' as const,
    onSortDirectionChange: vi.fn(),
    collapseSeriesEnabled: false,
    onCollapseSeriesToggle: vi.fn(),
    onRescan: vi.fn(),
    isRescanning: false,
    missingCount: 0,
    onRemoveMissing: vi.fn(),
    onSearchAllWanted: vi.fn(),
    isSearchingAllWanted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LibraryToolbar', () => {
  describe('search', () => {
    it('renders search input with placeholder', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByPlaceholderText('Search library...')).toBeInTheDocument();
    });

    it('calls onSearchChange when typing', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.type(screen.getByPlaceholderText('Search library...'), 'test');
      expect(props.onSearchChange).toHaveBeenCalled();
    });

    it('shows clear button when search has text', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ searchQuery: 'something' })} />,
      );
      expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
    });

    it('hides clear button when search is empty', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
    });

    it('calls onSearchClear when clear button is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ searchQuery: 'test' });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByLabelText('Clear search'));
      expect(props.onSearchClear).toHaveBeenCalledTimes(1);
    });
  });

  describe('status pills', () => {
    it('renders status pills', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Wanted')).toBeInTheDocument();
    });
  });

  describe('filters toggle', () => {
    it('renders Filters button', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByLabelText('Toggle filters')).toBeInTheDocument();
    });

    it('calls onFiltersToggle when clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByLabelText('Toggle filters'));
      expect(props.onFiltersToggle).toHaveBeenCalledTimes(1);
    });

    it('shows active filter count badge when count > 0', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ activeFilterCount: 2 })} />,
      );
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('hides active filter count badge when count is 0', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      // The only numbers visible should be status counts, not a filter badge
      const filtersButton = screen.getByLabelText('Toggle filters');
      expect(filtersButton.textContent).not.toContain('0');
    });
  });

  describe('filter row visibility', () => {
    it('shows FilterRow when filtersOpen is true', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ filtersOpen: true })} />,
      );
      expect(screen.getByText('All Authors')).toBeInTheDocument();
    });

    it('hides FilterRow when filtersOpen is false', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.queryByText('All Authors')).not.toBeInTheDocument();
    });
  });

  describe('rescan button', () => {
    it('renders Rescan button', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByText('Rescan')).toBeInTheDocument();
    });

    it('calls onRescan when clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByText('Rescan'));
      expect(props.onRescan).toHaveBeenCalledTimes(1);
    });

    it('disables button while rescanning', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ isRescanning: true })} />,
      );
      const button = screen.getByText('Rescan').closest('button');
      expect(button).toBeDisabled();
    });

    it('does not call onRescan when disabled', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ isRescanning: true });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByText('Rescan'));
      expect(props.onRescan).not.toHaveBeenCalled();
    });
  });

  describe('remove missing button', () => {
    it('shows Remove Missing button when missingCount > 0', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps({ missingCount: 3 })} />);
      expect(screen.getByText('Remove Missing')).toBeInTheDocument();
    });

    it('hides Remove Missing button when missingCount is 0', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps({ missingCount: 0 })} />);
      expect(screen.queryByText('Remove Missing')).not.toBeInTheDocument();
    });

    it('calls onRemoveMissing when clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ missingCount: 5 });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByText('Remove Missing'));
      expect(props.onRemoveMissing).toHaveBeenCalledTimes(1);
    });
  });

  describe('sort controls', () => {
    it('renders sort dropdown in main toolbar', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByText('Date Added')).toBeInTheDocument();
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Author')).toBeInTheDocument();
    });

    it('fires onSortFieldChange when sort field is changed', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.selectOptions(screen.getByDisplayValue('Date Added'), 'title');
      expect(props.onSortFieldChange).toHaveBeenCalledWith('title');
    });

    it('fires onSortDirectionChange when direction toggle is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ sortDirection: 'desc' as const });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByTitle('Sort descending'));
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });
  });

  describe('collapse series toggle', () => {
    it('renders Series toggle button', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByLabelText('Collapse series')).toBeInTheDocument();
      expect(screen.getByText('Series')).toBeInTheDocument();
    });

    it('fires onCollapseSeriesToggle when clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByLabelText('Collapse series'));
      expect(props.onCollapseSeriesToggle).toHaveBeenCalledTimes(1);
    });

    it('shows pressed state when enabled', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ collapseSeriesEnabled: true })} />,
      );
      expect(screen.getByLabelText('Collapse series')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('import link', () => {
    it('renders Import link', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByText('Import')).toBeInTheDocument();
    });

    it('Import link points to /import', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      const link = screen.getByText('Import').closest('a');
      expect(link).toHaveAttribute('href', '/import');
    });
  });
});
