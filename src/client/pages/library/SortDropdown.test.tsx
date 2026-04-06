import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

    it('panel covers 3 sort fields in both directions (6 total options)', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(6);
    });

    it('includes Date Added, Title, Author options in correct order', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveAccessibleName('Date Added (Newest)');
      expect(options[1]).toHaveAccessibleName('Date Added (Oldest)');
      expect(options[2]).toHaveAccessibleName('Title (A→Z)');
      expect(options[3]).toHaveAccessibleName('Title (Z→A)');
      expect(options[4]).toHaveAccessibleName('Author (A→Z)');
      expect(options[5]).toHaveAccessibleName('Author (Z→A)');
    });

    it('does not render Quality, Size, Format, Narrator, or Series options', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /date added/i }));

      expect(screen.queryByRole('option', { name: /quality/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /size/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /format/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /narrator/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /series/i })).not.toBeInTheDocument();
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

    it('clicking outside (non-interactive) returns focus to the trigger button', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <SortDropdown {...defaultProps()} />
          <div data-testid="outside" />
        </div>,
      );

      const trigger = screen.getByRole('button', { name: /date added/i });
      await user.click(trigger);
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(trigger).toHaveFocus();
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

  describe('keyboard navigation', () => {
    it('focuses the first option when dropdown opens', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveFocus();
    });

    it('ArrowDown moves focus to the next option', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{ArrowDown}');
      const options = screen.getAllByRole('option');
      expect(options[1]).toHaveFocus();
    });

    it('ArrowDown wraps from the 6th option (index 5) back to the first', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      // 5 ArrowDowns from index 0 reaches index 5 (last)
      for (let i = 0; i < 5; i++) await user.keyboard('{ArrowDown}');
      await user.keyboard('{ArrowDown}'); // wraps to index 0
      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveFocus();
    });

    it('ArrowUp moves focus to the previous option', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{ArrowDown}'); // index 1
      await user.keyboard('{ArrowUp}');   // back to index 0
      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveFocus();
    });

    it('ArrowUp wraps from the first option to the 6th (index 5)', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{ArrowUp}'); // wraps to index 5
      const options = screen.getAllByRole('option');
      expect(options[5]).toHaveFocus();
    });

    it('Enter on a focused option calls onSortFieldChange and onSortDirectionChange with correct values', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<SortDropdown {...props} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{ArrowDown}'); // index 1: createdAt-asc (Date Added Oldest)
      await user.keyboard('{Enter}');
      expect(props.onSortFieldChange).toHaveBeenCalledWith('createdAt');
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });

    it('Enter on a focused option closes the dropdown', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{Enter}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('Space on a focused option calls onSortFieldChange and onSortDirectionChange with correct values', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<SortDropdown {...props} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard('{ArrowDown}'); // index 1: createdAt-asc
      await user.keyboard(' ');
      expect(props.onSortFieldChange).toHaveBeenCalledWith('createdAt');
      expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
    });

    it('Space on a focused option closes the dropdown', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /date added/i }));
      await user.keyboard(' ');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('after keyboard selection, focus returns to the trigger button', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      const trigger = screen.getByRole('button', { name: /date added/i });
      await user.click(trigger);
      await user.keyboard('{Enter}');
      expect(trigger).toHaveFocus();
    });

    it('Escape closes the dropdown and returns focus to the trigger button', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      const trigger = screen.getByRole('button', { name: /date added/i });
      await user.click(trigger);
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('closing via trigger after ArrowDown resets focus so reopen starts at the first option', async () => {
      const user = userEvent.setup();
      render(<SortDropdown {...defaultProps()} />);
      const trigger = screen.getByRole('button', { name: /date added/i });
      await user.click(trigger);
      await user.keyboard('{ArrowDown}'); // move off first item
      await user.click(trigger); // close via trigger
      await user.click(trigger); // reopen
      expect(screen.getAllByRole('option')[0]).toHaveFocus();
    });
  });

  describe('accessibility', () => {
    it('menu option buttons have the focus-ring utility class applied', () => {
      render(<SortDropdown {...defaultProps()} />);
      fireEvent.click(screen.getByRole('button', { name: /date added.*newest/i }));
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThan(0);
      options.forEach((option) => expect(option).toHaveClass('focus-ring'));
    });
  });
});
