import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortDropdown } from './SortDropdown';

function defaultProps(overrides = {}) {
  return {
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

describe('SortDropdown', () => {
  describe('trigger label', () => {
    it('shows "Date Added (Newest)" when sortField is "createdAt" and direction is "desc"', () => {
      render(<SortDropdown {...defaultProps({ sortField: 'createdAt', sortDirection: 'desc' })} />);
      expect(screen.getByRole('button', { name: /date added.*newest/i })).toBeInTheDocument();
    });

    it('shows "Date Added (Oldest)" when sortField is "createdAt" and direction is "asc"', () => {
      render(<SortDropdown {...defaultProps({ sortField: 'createdAt', sortDirection: 'asc' })} />);
      expect(screen.getByRole('button', { name: /date added.*oldest/i })).toBeInTheDocument();
    });

    it('shows "Title (A→Z)" when sortField is "title" and direction is "asc"', () => {
      render(<SortDropdown {...defaultProps({ sortField: 'title', sortDirection: 'asc' })} />);
      expect(screen.getByRole('button', { name: /title.*a.*z/i })).toBeInTheDocument();
    });

    it('shows "Title (Z→A)" when sortField is "title" and direction is "desc"', () => {
      render(<SortDropdown {...defaultProps({ sortField: 'title', sortDirection: 'desc' })} />);
      expect(screen.getByRole('button', { name: /title.*z.*a/i })).toBeInTheDocument();
    });

    it('shows "Author (A→Z)" when sortField is "author" and direction is "asc"', () => {
      render(<SortDropdown {...defaultProps({ sortField: 'author', sortDirection: 'asc' })} />);
      expect(screen.getByRole('button', { name: /author.*a.*z/i })).toBeInTheDocument();
    });
  });

  describe('dropdown panel', () => {
    it('opens panel when trigger is clicked', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('panel covers all 5 sort fields in both directions (10 total options)', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(10);
    });

    it('includes Date Added, Title, Author, Narrator, Series options', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      expect(screen.getByRole('option', { name: /date added.*newest/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /title.*a.*z/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /author.*a.*z/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /narrator.*a.*z/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /series.*a.*z/i })).toBeInTheDocument();
    });

    it('does not render Quality, Size, or Format options', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      expect(screen.queryByRole('option', { name: /quality/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /size/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /format/i })).not.toBeInTheDocument();
    });

    it('closes panel when Escape is pressed', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('closes panel when clicking outside', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <SortDropdown {...defaultProps()} />
          <button data-testid="outside">outside</button>
        </div>,
      );

      await user.click(screen.getByRole('button', { name: /date added/i }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await user.click(screen.getByTestId('outside'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('calls onSortFieldChange and onSortDirectionChange when option is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<SortDropdown {...props} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      expect(props.onSortFieldChange).toHaveBeenCalledWith('title');
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });

    it('calls onSortFieldChange("createdAt") and onSortDirectionChange("asc") for "Date Added (Oldest)"', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<SortDropdown {...props} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.click(screen.getByRole('option', { name: /date added.*oldest/i }));

      expect(props.onSortFieldChange).toHaveBeenCalledWith('createdAt');
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });

    it('closes panel after selecting an option', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('marks the currently active sort combination with aria-selected', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps({ sortField: 'title', sortDirection: 'asc' })} />);

      await user.click(screen.getByRole('button', { name: /title.*a.*z/i }));

      expect(screen.getByRole('option', { name: /title.*a.*z/i })).toHaveAttribute('aria-selected', 'true');
    });
  });
});
