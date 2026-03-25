import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusDropdown } from './StatusDropdown';
import type { StatusFilter } from './helpers';

const defaultCounts: Record<StatusFilter, number> = {
  all: 25,
  wanted: 10,
  downloading: 3,
  imported: 12,
  failed: 2,
  missing: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StatusDropdown', () => {
  describe('trigger label', () => {
    it('shows current status label and count in the trigger (e.g. "Wanted (10)")', () => {
      render(
        <StatusDropdown
          statusFilter="wanted"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );
      expect(screen.getByRole('button', { name: /wanted.*10/i })).toBeInTheDocument();
    });

    it('shows "All (N)" label when statusFilter is "all"', () => {
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );
      expect(screen.getByRole('button', { name: /all.*25/i })).toBeInTheDocument();
    });

    it('shows count as 0 (not blank) when statusCounts[statusFilter] is 0', () => {
      const zeroCounts = { ...defaultCounts, wanted: 0 };
      render(
        <StatusDropdown
          statusFilter="wanted"
          onStatusFilterChange={vi.fn()}
          statusCounts={zeroCounts}
        />,
      );
      expect(screen.getByRole('button', { name: /wanted.*0/i })).toBeInTheDocument();
    });
  });

  describe('dropdown panel', () => {
    it('opens panel showing all 6 status options with counts when trigger is clicked', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all.*25/i }));

      // All 6 options should now be visible
      expect(screen.getByRole('option', { name: /all/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /wanted/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /downloading/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /imported/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /failed/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /missing/i })).toBeInTheDocument();
    });

    it('shows counts for all status options in the panel', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));

      // Each option should display its count
      expect(screen.getByRole('option', { name: /wanted.*10/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /downloading.*3/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /imported.*12/i })).toBeInTheDocument();
    });

    it('closes panel when trigger is clicked again', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );
      const trigger = screen.getByRole('button', { name: /all/i });

      await user.click(trigger);
      expect(screen.getByRole('option', { name: /wanted/i })).toBeInTheDocument();

      await user.click(trigger);
      expect(screen.queryByRole('option', { name: /wanted/i })).not.toBeInTheDocument();
    });

    it('closes panel when Escape is pressed', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));
      expect(screen.getByRole('option', { name: /wanted/i })).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('option', { name: /wanted/i })).not.toBeInTheDocument();
    });

    it('renders panel into document.body portal', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));

      // The listbox should be a descendant of document.body via portal
      const listbox = screen.getByRole('listbox');
      expect(document.body.contains(listbox)).toBe(true);
    });
  });

  describe('selection', () => {
    it('calls onStatusFilterChange with correct value when an option is clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={onChange}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /wanted/i }));

      expect(onChange).toHaveBeenCalledWith('wanted');
    });

    it('calls onStatusFilterChange("downloading") when Downloading option is clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={onChange}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /downloading/i }));

      expect(onChange).toHaveBeenCalledWith('downloading');
    });

    it('calls onStatusFilterChange("imported") when Imported option is clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={onChange}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /imported/i }));

      expect(onChange).toHaveBeenCalledWith('imported');
    });

    it('closes panel after selecting an option', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /wanted/i }));

      expect(screen.queryByRole('option', { name: /all/i })).not.toBeInTheDocument();
    });

    it('marks the currently active status option with aria-selected', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="wanted"
          onStatusFilterChange={vi.fn()}
          statusCounts={defaultCounts}
        />,
      );

      await user.click(screen.getByRole('button', { name: /wanted/i }));

      expect(screen.getByRole('option', { name: /wanted/i })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('status aggregation', () => {
    it('Downloading option shows the aggregated count passed via statusCounts', async () => {
      const user = userEvent.setup();
      // statusCounts.downloading=3 represents searching+downloading books (aggregated at service layer)
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={{ ...defaultCounts, downloading: 7 }}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));

      expect(screen.getByRole('option', { name: /downloading.*7/i })).toBeInTheDocument();
    });

    it('Imported option shows the aggregated count passed via statusCounts', async () => {
      const user = userEvent.setup();
      render(
        <StatusDropdown
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
          statusCounts={{ ...defaultCounts, imported: 5 }}
        />,
      );

      await user.click(screen.getByRole('button', { name: /all/i }));

      expect(screen.getByRole('option', { name: /imported.*5/i })).toBeInTheDocument();
    });
  });
});
