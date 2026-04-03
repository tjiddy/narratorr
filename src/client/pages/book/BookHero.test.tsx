import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BookHero } from './BookHero';

const defaultProps = {
  title: 'The Way of Kings',
  authorName: 'Brandon Sanderson',
  coverUrl: 'https://example.com/cover.jpg',
  metaDots: ['45h 0m', 'Fantasy', 'The Stormlight Archive #1'],
  statusLabel: 'Wanted',
  statusDotClass: 'bg-yellow-500',
  hasPath: true,
  onBackClick: vi.fn(),
  onSearchClick: vi.fn(),
  onEditClick: vi.fn(),
  onRenameClick: vi.fn(),
  isRenaming: false,
  onRetagClick: vi.fn(),
  isRetagging: false,
  retagDisabled: false,
  monitorForUpgrades: false,
  onMonitorToggle: vi.fn(),
  isMonitorToggling: false,
  onMergeClick: vi.fn(),
  isMerging: false,
  canMerge: false,
  mergeDisabled: false,
  onRemoveClick: vi.fn(),
  isRemoving: false,
};

function renderHero(overrides = {}) {
  return render(
    <MemoryRouter>
      <BookHero {...defaultProps} {...overrides} />
    </MemoryRouter>,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('More actions'));
}

describe('BookHero', () => {
  it('renders title', () => {
    renderHero();
    expect(screen.getByRole('heading', { level: 1, name: 'The Way of Kings' })).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    renderHero({ subtitle: 'Book One of the Stormlight Archive' });
    expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
  });

  it('renders author name', () => {
    renderHero();
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders meta dots', () => {
    renderHero();
    expect(screen.getByText('45h 0m · Fantasy · The Stormlight Archive #1')).toBeInTheDocument();
  });

  it('renders status badge', () => {
    renderHero();
    expect(screen.getByText('Wanted')).toBeInTheDocument();
  });

  it('renders cover image', () => {
    renderHero();
    const img = screen.getByAltText('Cover of The Way of Kings');
    expect(img).toHaveAttribute('src', 'https://example.com/cover.jpg');
  });

  it('calls onSearchClick when Search Releases button is clicked', async () => {
    const onSearchClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onSearchClick });

    await user.click(screen.getByText('Search Releases'));
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it('calls onEditClick when Edit menu item is clicked', async () => {
    const onEditClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onEditClick });

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Edit/ }));
    expect(onEditClick).toHaveBeenCalledTimes(1);
  });

  it('calls onRenameClick when Rename menu item is clicked', async () => {
    const onRenameClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onRenameClick });

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRenameClick).toHaveBeenCalledTimes(1);
  });

  it('hides Rename menu item when book has no path', async () => {
    const user = userEvent.setup();
    renderHero({ hasPath: false });
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument();
  });

  it('disables Rename menu item when renaming is in progress', async () => {
    const user = userEvent.setup();
    renderHero({ isRenaming: true });
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: /Renaming/ })).toBeDisabled();
  });

  it('calls onRetagClick when Re-tag menu item is clicked', async () => {
    const onRetagClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onRetagClick });

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Re-tag/ }));
    expect(onRetagClick).toHaveBeenCalledTimes(1);
  });

  it('hides Re-tag menu item when book has no path', async () => {
    const user = userEvent.setup();
    renderHero({ hasPath: false });
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: /Re-tag/ })).not.toBeInTheDocument();
  });

  it('disables Re-tag menu item when re-tagging is in progress', async () => {
    const user = userEvent.setup();
    renderHero({ isRetagging: true });
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: /Re-tagging/ })).toBeDisabled();
  });

  it('disables Re-tag menu item when retagDisabled is true', async () => {
    const user = userEvent.setup();
    renderHero({ retagDisabled: true, retagTooltip: 'Requires ffmpeg' });
    await openMenu(user);
    const item = screen.getByRole('menuitem', { name: /Re-tag/ });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'Requires ffmpeg');
  });

  describe('import list provenance', () => {
    it('renders "Added via" tag when importListName is set', () => {
      renderHero({ importListName: 'NYT Bestsellers' });
      expect(screen.getByText('Added via NYT Bestsellers')).toBeInTheDocument();
    });

    it('does not render provenance tag when importListName is null', () => {
      renderHero({ importListName: null });
      expect(screen.queryByText(/Added via/)).not.toBeInTheDocument();
    });
  });

  describe('URL_BASE resolveUrl integration', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prefixes both foreground and background cover URLs with URL_BASE via resolveUrl', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveUrl').mockImplementation(
        (url) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          return `/narratorr${url}`;
        },
      );

      render(
        <MemoryRouter>
          <BookHero {...defaultProps} coverUrl="/api/books/1/cover" />
        </MemoryRouter>,
      );

      // Foreground cover image
      const coverImg = screen.getByAltText('Cover of The Way of Kings');
      expect(coverImg).toHaveAttribute('src', '/narratorr/api/books/1/cover');

      // Background blur image
      const bgImg = screen.getByAltText('');
      expect(bgImg).toHaveAttribute('src', '/narratorr/api/books/1/cover');
    });
  });

  describe('monitor toggle button', () => {
    it('renders Monitor button when not monitoring', () => {
      renderHero({ monitorForUpgrades: false });
      expect(screen.getByText('Monitor')).toBeInTheDocument();
    });

    it('renders Monitoring button when monitoring is active', () => {
      renderHero({ monitorForUpgrades: true });
      expect(screen.getByText('Monitoring')).toBeInTheDocument();
    });

    it('calls onMonitorToggle when toggle is clicked', async () => {
      const onMonitorToggle = vi.fn();
      const user = userEvent.setup();
      renderHero({ onMonitorToggle });

      await user.click(screen.getByText('Monitor'));
      expect(onMonitorToggle).toHaveBeenCalledTimes(1);
    });

    it('disables toggle when isMonitorToggling is true', () => {
      renderHero({ isMonitorToggling: true });
      const button = screen.getByText('Monitor').closest('button');
      expect(button).toBeDisabled();
    });
  });

  describe('merge button', () => {
    it('calls onMergeClick when Merge to M4B menu item is clicked', async () => {
      const onMergeClick = vi.fn();
      const user = userEvent.setup();
      renderHero({ onMergeClick, canMerge: true });

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Merge to M4B/ }));
      expect(onMergeClick).toHaveBeenCalledTimes(1);
    });

    it('shows "Merging..." text and disables menu item during isMerging', async () => {
      const user = userEvent.setup();
      renderHero({ canMerge: true, isMerging: true });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /Merging/ });
      expect(item).toBeDisabled();
      expect(item).toHaveTextContent('Merging...');
    });

    it('disables menu item when mergeDisabled is true', async () => {
      const user = userEvent.setup();
      renderHero({ canMerge: true, mergeDisabled: true, mergeTooltip: 'Requires ffmpeg' });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /Merge to M4B/ });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('title', 'Requires ffmpeg');
    });

    it('does not render merge menu item when canMerge is false', async () => {
      const user = userEvent.setup();
      renderHero({ canMerge: false });
      await openMenu(user);
      expect(screen.queryByRole('menuitem', { name: /Merge/ })).not.toBeInTheDocument();
    });
  });

  describe('remove button', () => {
    it('renders Remove in the overflow menu', async () => {
      const user = userEvent.setup();
      renderHero();
      await openMenu(user);
      expect(screen.getByRole('menuitem', { name: /Remove/ })).toBeInTheDocument();
    });

    it('calls onRemoveClick when clicked', async () => {
      const onRemoveClick = vi.fn();
      const user = userEvent.setup();
      renderHero({ onRemoveClick });

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Remove/ }));
      expect(onRemoveClick).toHaveBeenCalledTimes(1);
    });

    it('disables menu item and shows pending label when isRemoving is true', async () => {
      const user = userEvent.setup();
      renderHero({ isRemoving: true });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /Removing/ });
      expect(item).toBeDisabled();
      expect(item).toHaveTextContent('Removing...');
    });

    it('shows normal label when isRemoving is false', async () => {
      const user = userEvent.setup();
      renderHero({ isRemoving: false });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /Remove/ });
      expect(item).not.toBeDisabled();
      expect(item).toHaveTextContent('Remove');
    });
  });

  describe('Wrong Release button', () => {
    it('renders Wrong Release in overflow menu when showWrongRelease is true', async () => {
      const user = userEvent.setup();
      renderHero({ showWrongRelease: true, onWrongReleaseClick: vi.fn(), isWrongReleasing: false });
      await openMenu(user);
      expect(screen.getByRole('menuitem', { name: /Wrong Release/ })).toBeInTheDocument();
    });

    it('does not render Wrong Release in overflow menu when showWrongRelease is false', async () => {
      const user = userEvent.setup();
      renderHero({ showWrongRelease: false, onWrongReleaseClick: vi.fn() });
      await openMenu(user);
      expect(screen.queryByRole('menuitem', { name: /Wrong Release/ })).not.toBeInTheDocument();
    });

    it('calls onWrongReleaseClick when Wrong Release menu item is clicked', async () => {
      const user = userEvent.setup();
      const onWrongReleaseClick = vi.fn();
      renderHero({ showWrongRelease: true, onWrongReleaseClick, isWrongReleasing: false });

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Wrong Release/ }));
      expect(onWrongReleaseClick).toHaveBeenCalledTimes(1);
    });

    it('disables menu item and shows pending label when isWrongReleasing is true', async () => {
      const user = userEvent.setup();
      renderHero({ showWrongRelease: true, onWrongReleaseClick: vi.fn(), isWrongReleasing: true });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /Rejecting/ });
      expect(item).toBeDisabled();
      expect(item).toHaveTextContent('Rejecting...');
    });
  });

  describe('#324 — overflow menu for secondary actions', () => {
    it('primary actions (Monitor, Search Releases) render as visible buttons outside overflow menu', () => {
      renderHero();
      // These are always visible without opening the menu
      expect(screen.getByText('Monitor')).toBeInTheDocument();
      expect(screen.getByText('Search Releases')).toBeInTheDocument();
    });

    it('secondary actions render inside overflow/kebab menu', async () => {
      const user = userEvent.setup();
      renderHero({ canMerge: true });

      // Before opening menu, secondary items are not in the DOM
      expect(screen.queryByRole('menuitem', { name: /Edit/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument();

      await openMenu(user);

      // After opening, they appear
      expect(screen.getByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Re-tag/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Merge/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Remove/ })).toBeInTheDocument();
    });

    it('clicking kebab menu button opens dropdown', async () => {
      const user = userEvent.setup();
      renderHero();

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      await openMenu(user);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('Escape closes the overflow menu', async () => {
      const user = userEvent.setup();
      renderHero();

      await openMenu(user);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('ArrowDown moves focus to next menu item', async () => {
      const user = userEvent.setup();
      renderHero();

      await openMenu(user);
      const items = screen.getAllByRole('menuitem');
      // First item should be focused initially
      expect(document.activeElement).toBe(items[0]);

      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(items[1]);
    });

    it('ArrowUp wraps focus to last menu item from first', async () => {
      const user = userEvent.setup();
      renderHero();

      await openMenu(user);
      const items = screen.getAllByRole('menuitem');
      expect(document.activeElement).toBe(items[0]);

      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(items[items.length - 1]);
    });

    it('Enter activates the focused menu item', async () => {
      const onEditClick = vi.fn();
      const user = userEvent.setup();
      renderHero({ onEditClick });

      await openMenu(user);
      // Edit is the first menu item — press Enter to activate
      await user.keyboard('{Enter}');
      expect(onEditClick).toHaveBeenCalledTimes(1);
    });
  });
});
