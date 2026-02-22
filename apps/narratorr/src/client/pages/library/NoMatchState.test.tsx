import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoMatchState } from './NoMatchState';

describe('NoMatchState', () => {
  it('renders heading message', () => {
    render(<NoMatchState onClearFilters={vi.fn()} />);
    expect(screen.getByText('No books match your filters')).toBeInTheDocument();
  });

  it('renders helper text', () => {
    render(<NoMatchState onClearFilters={vi.fn()} />);
    expect(screen.getByText('Try adjusting your filters to see more results')).toBeInTheDocument();
  });

  it('renders Clear Filters button', () => {
    render(<NoMatchState onClearFilters={vi.fn()} />);
    expect(screen.getByText('Clear Filters')).toBeInTheDocument();
  });

  it('calls onClearFilters when button is clicked', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    render(<NoMatchState onClearFilters={onClearFilters} />);

    await user.click(screen.getByText('Clear Filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
