import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryActions } from './LibraryActions';

function defaultProps(overrides = {}) {
  return {
    missingCount: 0,
    onRemoveMissing: vi.fn(),
    onSearchAllWanted: vi.fn(),
    isSearchingAllWanted: false,
    onRescan: vi.fn(),
    isRescanning: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LibraryActions', () => {
  it('calls onSearchAllWanted when Search Wanted button is clicked', async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    renderWithProviders(<LibraryActions {...props} />);

    await user.click(screen.getByRole('button', { name: /search wanted/i }));

    expect(props.onSearchAllWanted).toHaveBeenCalledTimes(1);
  });

  it('disables Search Wanted button when isSearchingAllWanted is true', () => {
    renderWithProviders(<LibraryActions {...defaultProps({ isSearchingAllWanted: true })} />);

    expect(screen.getByRole('button', { name: /search wanted/i })).toBeDisabled();
  });

  it('hides Remove Missing button when missingCount is 0', () => {
    renderWithProviders(<LibraryActions {...defaultProps({ missingCount: 0 })} />);
    expect(screen.queryByRole('button', { name: /remove missing/i })).not.toBeInTheDocument();
  });

  it('shows Remove Missing button when missingCount > 0', () => {
    renderWithProviders(<LibraryActions {...defaultProps({ missingCount: 3 })} />);
    expect(screen.getByRole('button', { name: /remove missing/i })).toBeInTheDocument();
  });
});
