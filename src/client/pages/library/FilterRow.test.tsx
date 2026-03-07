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

  describe('sort controls removed', () => {
    it('does not render sort dropdown (moved to toolbar)', () => {
      render(<FilterRow {...defaultProps()} />);
      expect(screen.queryByText('Date Added')).not.toBeInTheDocument();
      expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });
});
