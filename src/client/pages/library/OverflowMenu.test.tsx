import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { OverflowMenu } from './OverflowMenu';

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

describe('OverflowMenu', () => {
  describe('trigger', () => {
    it('renders a ⋮ trigger button', () => {
      renderWithProviders(<OverflowMenu {...defaultProps()} />);
      expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
    });

    it('opens menu when trigger is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('closes menu when trigger is clicked again', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);
      const trigger = screen.getByRole('button', { name: /more actions/i });

      await user.click(trigger);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.click(trigger);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('menu panel', () => {
    it('shows Search Wanted, Rescan, and Import items when open', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /search wanted/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /rescan/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /import/i })).toBeInTheDocument();
    });

    it('closes when Escape is pressed', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes when clicking outside', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <div>
          <OverflowMenu {...defaultProps()} />
          <button data-testid="outside">outside</button>
        </div>,
      );

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.click(screen.getByTestId('outside'));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('renders menu into document.body portal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(document.body.querySelector('[role="menu"]')).toBeInTheDocument();
    });
  });

  describe('Remove Missing item', () => {
    it('shows Remove Missing item when missingCount > 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps({ missingCount: 3 })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /remove missing/i })).toBeInTheDocument();
    });

    it('does not show Remove Missing item when missingCount is 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps({ missingCount: 0 })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.queryByRole('menuitem', { name: /remove missing/i })).not.toBeInTheDocument();
    });

    it('calls onRemoveMissing when Remove Missing is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ missingCount: 5 });
      renderWithProviders(<OverflowMenu {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));

      expect(props.onRemoveMissing).toHaveBeenCalledTimes(1);
    });
  });

  describe('Rescan item', () => {
    it('calls onRescan when Rescan is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<OverflowMenu {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      expect(props.onRescan).toHaveBeenCalledTimes(1);
    });

    it('Rescan item is disabled when isRescanning is true', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps({ isRescanning: true })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /rescan/i })).toBeDisabled();
    });

    it('does not call onRescan when Rescan item is disabled', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ isRescanning: true });
      renderWithProviders(<OverflowMenu {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      expect(props.onRescan).not.toHaveBeenCalled();
    });
  });

  describe('Search Wanted item', () => {
    it('calls onSearchAllWanted when Search Wanted is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      renderWithProviders(<OverflowMenu {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /search wanted/i }));

      expect(props.onSearchAllWanted).toHaveBeenCalledTimes(1);
    });

    it('Search Wanted item is disabled when isSearchingAllWanted is true', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps({ isSearchingAllWanted: true })} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      expect(screen.getByRole('menuitem', { name: /search wanted/i })).toBeDisabled();
    });

    it('does not call onSearchAllWanted when Search Wanted is disabled', async () => {
      const user = userEvent.setup();
      const props = defaultProps({ isSearchingAllWanted: true });
      renderWithProviders(<OverflowMenu {...props} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /search wanted/i }));

      expect(props.onSearchAllWanted).not.toHaveBeenCalled();
    });
  });

  describe('Import item', () => {
    it('Import item points to /import', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OverflowMenu {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));

      const importItem = screen.getByRole('menuitem', { name: /import/i });
      expect(importItem).toHaveAttribute('href', '/import');
    });
  });
});
