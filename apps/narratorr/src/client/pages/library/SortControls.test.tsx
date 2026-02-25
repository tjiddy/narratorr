import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortControls } from './SortControls';

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

describe('SortControls', () => {
  it('renders sort field dropdown with all options', () => {
    render(<SortControls {...defaultProps()} />);
    expect(screen.getByText('Date Added')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Author')).toBeInTheDocument();
  });

  it('calls onSortFieldChange when field is changed', async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    render(<SortControls {...props} />);

    await user.selectOptions(screen.getByDisplayValue('Date Added'), 'title');
    expect(props.onSortFieldChange).toHaveBeenCalledWith('title');
  });

  it('calls onSortDirectionChange when direction button is clicked', async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    render(<SortControls {...props} />);

    await user.click(screen.getByTitle('Sort descending'));
    expect(props.onSortDirectionChange).toHaveBeenCalledWith('asc');
  });

  it('toggles direction from asc to desc', async () => {
    const user = userEvent.setup();
    const props = defaultProps({ sortDirection: 'asc' as const });
    render(<SortControls {...props} />);

    await user.click(screen.getByTitle('Sort ascending'));
    expect(props.onSortDirectionChange).toHaveBeenCalledWith('desc');
  });
});
