import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryToolbar } from './LibraryToolbar';
import type { StatusFilter } from './helpers';
import type { FilterProps } from './FilterRow';
import type { SortProps } from './SortDropdown';

function defaultFilterProps(overrides: Partial<FilterProps> = {}): FilterProps {
  return {
    authorFilter: '',
    onAuthorFilterChange: vi.fn(),
    uniqueAuthors: ['Author A', 'Author B'],
    seriesFilter: '',
    onSeriesFilterChange: vi.fn(),
    uniqueSeries: ['Series A'],
    narratorFilter: '',
    onNarratorFilterChange: vi.fn(),
    uniqueNarrators: ['Narrator A', 'Narrator B'],
    ...overrides,
  };
}

function defaultSortProps(overrides: Partial<SortProps> = {}): SortProps {
  return {
    sortField: 'createdAt' as const,
    onSortFieldChange: vi.fn(),
    sortDirection: 'desc' as const,
    onSortDirectionChange: vi.fn(),
    ...overrides,
  };
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  const {
    filterProps: filterOverrides,
    sortProps: sortOverrides,
    ...rest
  } = overrides as { filterProps?: Partial<FilterProps>; sortProps?: Partial<SortProps>; [key: string]: unknown };

  return {
    searchQuery: '',
    onSearchChange: vi.fn(),
    onSearchClear: vi.fn(),
    statusFilter: 'all' as StatusFilter,
    onStatusFilterChange: vi.fn(),
    statusCounts: { all: 25, wanted: 10, downloading: 3, imported: 12, failed: 2, missing: 1 } as Record<StatusFilter, number>,
    filtersOpen: false,
    onFiltersToggle: vi.fn(),
    activeFilterCount: 0,
    filterProps: defaultFilterProps(filterOverrides),
    sortProps: defaultSortProps(sortOverrides),
    collapseSeriesEnabled: false,
    onCollapseSeriesToggle: vi.fn(),
    viewMode: 'grid' as const,
    onViewModeChange: vi.fn(),
    onRescan: vi.fn(),
    isRescanning: false,
    missingCount: 0,
    onRemoveMissing: vi.fn(),
    onSearchAllWanted: vi.fn(),
    isSearchingAllWanted: false,
    ...rest,
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

  describe('status dropdown', () => {
    it('renders a status dropdown trigger showing current status label and count', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps({ statusFilter: 'wanted' as StatusFilter })} />);
      expect(screen.getByRole('button', { name: /wanted.*10/i })).toBeInTheDocument();
    });

    it('does not render 6 individual status pill buttons', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      // Should have one dropdown trigger, not 6 pills. The trigger opens options on click.
      expect(screen.queryByRole('option', { name: /wanted/i })).not.toBeInTheDocument();
    });

    it('opens status options panel when trigger is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /all.*25/i }));

      expect(screen.getByRole('option', { name: /wanted/i })).toBeInTheDocument();
    });

    it('calls onStatusFilterChange when a status option is selected', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /all.*25/i }));
      await user.click(screen.getByRole('option', { name: /wanted/i }));

      expect(props.onStatusFilterChange).toHaveBeenCalledWith('wanted');
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
        <LibraryToolbar {...defaultProps({ activeFilterCount: 3 })} />,
      );
      const filtersButton = screen.getByLabelText('Toggle filters');
      expect(filtersButton.textContent).toContain('3');
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

  describe('sort dropdown', () => {
    it('renders a combined sort dropdown trigger (not a separate field select + direction button)', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      // The combined trigger shows "Date Added (Newest)" for createdAt/desc defaults
      expect(screen.getByRole('button', { name: /date added.*newest/i })).toBeInTheDocument();
      // No more separate field select or direction button
      expect(screen.queryByLabelText('Sort field')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Sort descending')).not.toBeInTheDocument();
    });

    it('fires onSortFieldChange and onSortDirectionChange when a sort option is selected', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      expect(props.sortProps.onSortFieldChange).toHaveBeenCalledWith('title');
      expect(props.sortProps.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });
  });

  describe('overflow menu (replaces top-level action buttons)', () => {
    it('renders a ⋮ overflow menu trigger instead of top-level Rescan/Search Wanted/Import buttons', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
      // Top-level Rescan and Search Wanted buttons should not be present outside the menu
      expect(screen.queryByText('Rescan')).not.toBeInTheDocument();
      expect(screen.queryByText('Search Wanted')).not.toBeInTheDocument();
    });

    it('clicking ⋮ opens menu with Rescan, Search Wanted, Import items', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /rescan/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /search wanted/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /import/i })).toBeInTheDocument();
    });

    it('overflow menu Rescan item calls onRescan', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      expect(props.onRescan).toHaveBeenCalledTimes(1);
    });

    it('overflow menu Search Wanted item calls onSearchAllWanted', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /search wanted/i }));

      expect(props.onSearchAllWanted).toHaveBeenCalledTimes(1);
    });

    it('Remove Missing item appears in overflow menu when missingCount > 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibraryToolbar {...defaultProps({ missingCount: 3 })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /remove missing/i })).toBeInTheDocument();
    });

    it('Remove Missing item absent from overflow menu when missingCount is 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibraryToolbar {...defaultProps({ missingCount: 0 })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.queryByRole('menuitem', { name: /remove missing/i })).not.toBeInTheDocument();
    });

    it('overflow menu Remove Missing item calls onRemoveMissing', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ missingCount: 5 });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));

      expect(props.onRemoveMissing).toHaveBeenCalledTimes(1);
    });
  });

  describe('collapse series toggle', () => {
    it('renders Series toggle button', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      const toggle = screen.getByLabelText('Collapse series');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveTextContent('Series');
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

  describe('grouped prop interface', () => {
    it('passes filter props through to FilterRow', () => {
      renderWithProviders(
        <LibraryToolbar {...defaultProps({ filtersOpen: true })} />,
      );
      // FilterRow renders All Authors, All Series, All Narrators selects
      expect(screen.getByText('All Authors')).toBeInTheDocument();
      expect(screen.getByText('All Series')).toBeInTheDocument();
      expect(screen.getByText('All Narrators')).toBeInTheDocument();
    });

    it('passes sort props through to SortDropdown (trigger reflects active sort)', () => {
      renderWithProviders(
        <LibraryToolbar
          {...defaultProps({ sortProps: defaultSortProps({ sortField: 'author' as const, sortDirection: 'asc' as const }) })}
        />,
      );
      expect(screen.getByRole('button', { name: /author.*a.*z/i })).toBeInTheDocument();
    });
  });

  describe('view toggle (must remain top-level)', () => {
    it('view toggle is still rendered as a top-level element', () => {
      renderWithProviders(<LibraryToolbar {...defaultProps()} />);
      // ViewToggle renders grid/table toggle buttons
      expect(screen.getByLabelText('Grid view')).toBeInTheDocument();
    });

    it('calls onViewModeChange when view toggle is used', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ viewMode: 'grid' as const });
      renderWithProviders(<LibraryToolbar {...props} />);

      await user.click(screen.getByLabelText('Table view'));
      expect(props.onViewModeChange).toHaveBeenCalledWith('table');
    });
  });
});
