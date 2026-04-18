import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookContextMenu } from './BookContextMenu';

beforeEach(() => {
  vi.clearAllMocks();
});

function renderMenu(overrides = {}) {
  const props = {
    onSearchReleases: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BookContextMenu {...props} />);
  return props;
}

describe('BookContextMenu', () => {
  it('renders menu with correct role', () => {
    renderMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('renders Search Releases and Remove from Library items', () => {
    renderMenu();
    expect(screen.getByText('Search Releases')).toBeInTheDocument();
    expect(screen.getByText('Remove from Library')).toBeInTheDocument();
  });

  it('renders menu items with menuitem role', () => {
    renderMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
  });

  it('calls onSearchReleases when Search Releases is clicked', async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(screen.getByText('Search Releases'));
    expect(props.onSearchReleases).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove when Remove from Library is clicked', async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(screen.getByText('Remove from Library'));
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });

  describe('keyboard navigation', () => {
    it('focuses first item on initial render', () => {
      renderMenu();
      const items = screen.getAllByRole('menuitem');
      expect(items[0]).toHaveFocus();
    });

    it('ArrowDown moves focus to next item', async () => {
      const user = userEvent.setup();
      renderMenu();

      await user.keyboard('{ArrowDown}');
      const items = screen.getAllByRole('menuitem');
      expect(items[1]).toHaveFocus();
    });

    it('ArrowDown on last item wraps to first', async () => {
      const user = userEvent.setup();
      renderMenu();

      await user.keyboard('{ArrowDown}'); // -> Remove
      await user.keyboard('{ArrowDown}'); // -> Search (wrap)
      const items = screen.getAllByRole('menuitem');
      expect(items[0]).toHaveFocus();
    });

    it('ArrowUp on first item wraps to last', async () => {
      const user = userEvent.setup();
      renderMenu();

      await user.keyboard('{ArrowUp}'); // wrap to Remove
      const items = screen.getAllByRole('menuitem');
      expect(items[1]).toHaveFocus();
    });

    it('Enter activates focused item', async () => {
      const user = userEvent.setup();
      const props = renderMenu();

      // Focus is on first item (Search Releases)
      await user.keyboard('{Enter}');
      expect(props.onSearchReleases).toHaveBeenCalledTimes(1);
    });

    it('Space activates focused item', async () => {
      const user = userEvent.setup();
      const props = renderMenu();

      await user.keyboard('{ArrowDown}'); // -> Remove
      await user.keyboard(' ');
      expect(props.onRemove).toHaveBeenCalledTimes(1);
    });

    it('Escape calls onClose', async () => {
      const user = userEvent.setup();
      const props = renderMenu();

      await user.keyboard('{Escape}');
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility', () => {
    it('all menu items have the focus-ring utility class applied', () => {
      renderMenu();
      const items = screen.getAllByRole('menuitem');
      expect(items.length).toBeGreaterThan(0);
      items.forEach((item) => expect(item).toHaveClass('focus-ring'));
    });
  });

  describe('z-index scale (CSS-1)', () => {
    it('context menu container has z-30 class (dropdown scale)', () => {
      renderMenu();
      const menu = screen.getByRole('menu');
      expect(menu).toHaveClass('z-30');
    });
  });

  describe('Retry Import action (#635)', () => {
    it('shows Retry Import item when onRetryImport is provided', () => {
      renderMenu({ onRetryImport: vi.fn() });
      expect(screen.getByText('Retry Import')).toBeInTheDocument();
    });

    it('does not show Retry Import item when onRetryImport is not provided', () => {
      renderMenu();
      expect(screen.queryByText('Retry Import')).not.toBeInTheDocument();
    });

    it('calls onRetryImport when clicked', async () => {
      const user = userEvent.setup();
      const onRetryImport = vi.fn();
      renderMenu({ onRetryImport });
      await user.click(screen.getByText('Retry Import'));
      expect(onRetryImport).toHaveBeenCalledTimes(1);
    });

    it('keyboard ArrowDown cycles through all 3 items and Enter invokes Retry Import (#636 F1)', async () => {
      const user = userEvent.setup();
      const onRetryImport = vi.fn();
      const onRemove = vi.fn();
      renderMenu({ onRetryImport, onRemove });

      // ArrowDown from Search Releases (index 0) → Retry Import (index 1)
      await user.keyboard('{ArrowDown}');
      // Enter should invoke Retry Import, NOT Remove
      await user.keyboard('{Enter}');

      expect(onRetryImport).toHaveBeenCalledTimes(1);
      expect(onRemove).not.toHaveBeenCalled();
    });

    it('keyboard ArrowDown wraps past Remove back to Search Releases with 3 items (#636 F1)', async () => {
      const user = userEvent.setup();
      const onSearchReleases = vi.fn();
      renderMenu({ onRetryImport: vi.fn(), onSearchReleases });

      // ArrowDown 3 times: Search (0) → Retry (1) → Remove (2) → Search (0)
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      await user.keyboard('{Enter}');

      expect(onSearchReleases).toHaveBeenCalledTimes(1);
    });
  });
});
