import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterRow } from './FilterRow';

function defaultProps(overrides = {}) {
  return {
    authorFilter: '',
    onAuthorFilterChange: vi.fn(),
    uniqueAuthors: ['Brandon Sanderson', 'Patrick Rothfuss'],
    seriesFilter: '',
    onSeriesFilterChange: vi.fn(),
    uniqueSeries: ['The Stormlight Archive'],
    sortField: 'createdAt' as const,
    onSortFieldChange: vi.fn(),
    sortDirection: 'desc' as const,
    onSortDirectionChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FilterRow', () => {
  describe('author filter', () => {
    it('shows author dropdown when more than 1 author', () => {
      render(<FilterRow {...defaultProps()} />);
      expect(screen.getByText('All Authors')).toBeInTheDocument();
    });

    it('hides author dropdown when 1 or fewer authors', () => {
      render(<FilterRow {...defaultProps({ uniqueAuthors: ['Solo Author'] })} />);
      expect(screen.queryByText('All Authors')).not.toBeInTheDocument();
    });

    it('hides author dropdown when 0 authors', () => {
      render(<FilterRow {...defaultProps({ uniqueAuthors: [] })} />);
      expect(screen.queryByText('All Authors')).not.toBeInTheDocument();
    });

    it('lists all authors as options', () => {
      render(<FilterRow {...defaultProps()} />);
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
      expect(screen.getByText('Patrick Rothfuss')).toBeInTheDocument();
    });

    it('calls onAuthorFilterChange when author is selected', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<FilterRow {...props} />);

      await user.selectOptions(
        screen.getByDisplayValue('All Authors'),
        'Brandon Sanderson',
      );
      expect(props.onAuthorFilterChange).toHaveBeenCalledWith('Brandon Sanderson');
    });
  });

  describe('series filter', () => {
    it('shows series dropdown when series exist', () => {
      render(<FilterRow {...defaultProps()} />);
      expect(screen.getByText('All Series')).toBeInTheDocument();
    });

    it('hides series dropdown when 0 series', () => {
      render(<FilterRow {...defaultProps({ uniqueSeries: [] })} />);
      expect(screen.queryByText('All Series')).not.toBeInTheDocument();
    });

    it('calls onSeriesFilterChange when series is selected', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<FilterRow {...props} />);

      await user.selectOptions(
        screen.getByDisplayValue('All Series'),
        'The Stormlight Archive',
      );
      expect(props.onSeriesFilterChange).toHaveBeenCalledWith('The Stormlight Archive');
    });
  });

  describe('sort controls', () => {
    it('renders sort field dropdown with all options', () => {
      render(<FilterRow {...defaultProps()} />);
      expect(screen.getByText('Date Added')).toBeInTheDocument();
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Author')).toBeInTheDocument();
    });

    it('calls onSortFieldChange when sort field is changed', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<FilterRow {...props} />);

      await user.selectOptions(screen.getByDisplayValue('Date Added'), 'title');
      expect(props.onSortFieldChange).toHaveBeenCalledWith('title');
    });

    it('calls onSortDirectionChange with opposite direction when toggle is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ sortDirection: 'desc' as const });
      render(<FilterRow {...props} />);

      await user.click(screen.getByTitle('Sort descending'));
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });

    it('shows Sort ascending title when direction is asc', () => {
      render(<FilterRow {...defaultProps({ sortDirection: 'asc' as const })} />);
      expect(screen.getByTitle('Sort ascending')).toBeInTheDocument();
    });
  });
});
