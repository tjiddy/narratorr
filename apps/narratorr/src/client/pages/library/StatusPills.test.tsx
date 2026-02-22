import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusPills } from './StatusPills';
import type { StatusFilter } from './helpers';

const defaultCounts: Record<StatusFilter, number> = {
  all: 25,
  wanted: 10,
  downloading: 3,
  imported: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StatusPills', () => {
  it('renders all tab labels', () => {
    render(
      <StatusPills
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        statusCounts={defaultCounts}
      />,
    );

    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Wanted')).toBeInTheDocument();
    expect(screen.getByText('Downloading')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
  });

  it('renders counts next to each tab', () => {
    render(
      <StatusPills
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        statusCounts={defaultCounts}
      />,
    );

    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('calls onStatusFilterChange with correct tab key on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StatusPills
        statusFilter="all"
        onStatusFilterChange={onChange}
        statusCounts={defaultCounts}
      />,
    );

    await user.click(screen.getByText('Wanted'));
    expect(onChange).toHaveBeenCalledWith('wanted');

    await user.click(screen.getByText('Downloading'));
    expect(onChange).toHaveBeenCalledWith('downloading');

    await user.click(screen.getByText('Imported'));
    expect(onChange).toHaveBeenCalledWith('imported');
  });

  it('renders 4 buttons total', () => {
    render(
      <StatusPills
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        statusCounts={defaultCounts}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(4);
  });
});
