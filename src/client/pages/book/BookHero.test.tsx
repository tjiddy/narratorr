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
  onMergeClick: vi.fn(),
  isMerging: false,
  canMerge: false,
  mergeDisabled: false,
  onRemoveClick: vi.fn(),
  isRemoving: false,
};

function renderHero(overrides = {}, children?: React.ReactNode) {
  return render(
    <MemoryRouter>
      <BookHero {...defaultProps} {...overrides}>{children}</BookHero>
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

  it('renders children between metadata and action buttons', () => {
    renderHero({}, <span data-testid="preview-slot">Preview</span>);
    const preview = screen.getByTestId('preview-slot');
    expect(preview).toBeInTheDocument();
    // Verify it appears before the action buttons (Wanted badge)
    const statusBadge = screen.getByText('Wanted');
    expect(preview.compareDocumentPosition(statusBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not render children wrapper when no children provided', () => {
    renderHero();
    expect(screen.queryByTestId('preview-slot')).not.toBeInTheDocument();
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

  describe('cover cache-busting', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('background blur image src includes ?v= cache-busting param from updatedAt', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveCoverUrl').mockImplementation(
        (url, updatedAt) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          const resolved = `/narratorr${url}`;
          if (!updatedAt) return resolved;
          return `${resolved}?v=${Math.floor(new Date(updatedAt).getTime() / 1000)}`;
        },
      );

      render(
        <MemoryRouter>
          <BookHero {...defaultProps} coverUrl="/api/books/1/cover" updatedAt="2024-04-08T12:00:00Z" />
        </MemoryRouter>,
      );

      const bgImg = screen.getByAltText('');
      expect(bgImg).toHaveAttribute('src', '/narratorr/api/books/1/cover?v=1712577600');
    });

    it('foreground cover image src includes ?v= cache-busting param from updatedAt', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveCoverUrl').mockImplementation(
        (url, updatedAt) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          const resolved = `/narratorr${url}`;
          if (!updatedAt) return resolved;
          return `${resolved}?v=${Math.floor(new Date(updatedAt).getTime() / 1000)}`;
        },
      );

      render(
        <MemoryRouter>
          <BookHero {...defaultProps} coverUrl="/api/books/1/cover" updatedAt="2024-04-08T12:00:00Z" />
        </MemoryRouter>,
      );

      const coverImg = screen.getByAltText('Cover of The Way of Kings');
      expect(coverImg).toHaveAttribute('src', '/narratorr/api/books/1/cover?v=1712577600');
    });

    it('both images update src when updatedAt prop changes', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveCoverUrl').mockImplementation(
        (url, updatedAt) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          const resolved = `/narratorr${url}`;
          if (!updatedAt) return resolved;
          return `${resolved}?v=${Math.floor(new Date(updatedAt).getTime() / 1000)}`;
        },
      );

      const { rerender } = render(
        <MemoryRouter>
          <BookHero {...defaultProps} coverUrl="/api/books/1/cover" updatedAt="2024-01-01T00:00:00Z" />
        </MemoryRouter>,
      );

      const coverImg = screen.getByAltText('Cover of The Way of Kings');
      expect(coverImg).toHaveAttribute('src', '/narratorr/api/books/1/cover?v=1704067200');

      rerender(
        <MemoryRouter>
          <BookHero {...defaultProps} coverUrl="/api/books/1/cover" updatedAt="2024-06-15T12:00:00Z" />
        </MemoryRouter>,
      );

      expect(coverImg).toHaveAttribute('src', '/narratorr/api/books/1/cover?v=1718452800');
    });

    it('renders fallback placeholder when coverUrl is null (no cache-busting needed)', () => {
      renderHero({ coverUrl: undefined, updatedAt: '2024-01-01T00:00:00Z' });
      expect(screen.queryByAltText('Cover of The Way of Kings')).not.toBeInTheDocument();
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

    describe('#368 merge queue — queued menu state', () => {
      it('shows "Queued..." when merge is in queued state (distinct from "Merging...")', async () => {
        const user = userEvent.setup();
        renderHero({ canMerge: true, isMerging: true, mergePhase: 'queued' });
        await openMenu(user);
        const item = screen.getByRole('menuitem', { name: /Queued/ });
        expect(item).toBeDisabled();
        expect(item).toHaveTextContent('Queued...');
      });
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
    it('primary action (Search Releases) renders as visible button outside overflow menu', () => {
      renderHero();
      // Always visible without opening the menu
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

  // #445 — Cover upload overlay
  describe('cover upload overlay', () => {
    describe('overlay visibility', () => {
      it('renders upload button on cover when book has path and onCoverFileSelect provided', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        expect(screen.getByLabelText('Upload cover')).toBeInTheDocument();
      });

      it('does not render upload button when book has no path', () => {
        renderHero({ hasPath: false, onCoverFileSelect: vi.fn() });
        expect(screen.queryByLabelText('Upload cover')).not.toBeInTheDocument();
      });

      it('clicking upload button triggers hidden file input', async () => {
        const user = userEvent.setup();
        const onCoverFileSelect = vi.fn();
        renderHero({ hasPath: true, onCoverFileSelect });

        const uploadBtn = screen.getByLabelText('Upload cover');
        // The button should exist and be clickable
        await user.click(uploadBtn);
        // Verify file input exists with correct accept attribute
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).not.toBeNull();
        expect(fileInput.accept).toBe('image/jpeg,image/png,image/webp');
      });
    });

    describe('file picker', () => {
      it('file input has accept attribute restricted to image types', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).not.toBeNull();
        expect(fileInput.accept).toBe('image/jpeg,image/png,image/webp');
      });
    });

    describe('preview state', () => {
      it('shows checkmark and X overlays when preview is active', () => {
        renderHero({
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm: vi.fn(),
          onCoverCancel: vi.fn(),
        });
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
        expect(screen.getByLabelText('Cancel cover')).toBeInTheDocument();
      });

      it('displays preview image instead of original cover', () => {
        renderHero({
          coverUrl: 'https://example.com/original.jpg',
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm: vi.fn(),
          onCoverCancel: vi.fn(),
        });
        const previewImg = screen.getByAltText('Cover preview');
        expect(previewImg).toBeInTheDocument();
        expect(previewImg).toHaveAttribute('src', 'blob:http://localhost/preview');
      });

      it('clicking checkmark calls onCoverConfirm', async () => {
        const user = userEvent.setup();
        const onCoverConfirm = vi.fn();
        renderHero({
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm,
          onCoverCancel: vi.fn(),
        });

        await user.click(screen.getByLabelText('Confirm cover'));
        expect(onCoverConfirm).toHaveBeenCalledTimes(1);
      });

      it('clicking X calls onCoverCancel', async () => {
        const user = userEvent.setup();
        const onCoverCancel = vi.fn();
        renderHero({
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm: vi.fn(),
          onCoverCancel,
        });

        await user.click(screen.getByLabelText('Cancel cover'));
        expect(onCoverCancel).toHaveBeenCalledTimes(1);
      });

      it('disables confirm and cancel buttons when upload is in progress', () => {
        renderHero({
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm: vi.fn(),
          onCoverCancel: vi.fn(),
          isUploadingCover: true,
        });

        expect(screen.getByLabelText('Confirm cover')).toBeDisabled();
        expect(screen.getByLabelText('Cancel cover')).toBeDisabled();
      });

      it('does not show upload overlay when preview is active (confirm/cancel shown instead)', () => {
        renderHero({
          hasPath: true,
          onCoverFileSelect: vi.fn(),
          previewUrl: 'blob:http://localhost/preview',
          onCoverConfirm: vi.fn(),
          onCoverCancel: vi.fn(),
        });

        // Upload button should NOT be visible when preview is active
        expect(screen.queryByLabelText('Upload cover')).not.toBeInTheDocument();
        // Confirm/cancel should be visible
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
      });
    });

    describe('touch affordance CSS classes', () => {
      it('upload overlay button includes no-hover:opacity-100 class for touch device visibility', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        const uploadBtn = screen.getByLabelText('Upload cover');
        expect(uploadBtn).toHaveClass('no-hover:opacity-100');
      });

      it('upload icon container includes no-hover:scale-100 class for touch device full-size display', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        const uploadBtn = screen.getByLabelText('Upload cover');
        const iconContainer = uploadBtn.firstElementChild as HTMLElement;
        expect(iconContainer).toHaveClass('no-hover:scale-100');
      });

      it('upload overlay button retains opacity-0 and group-hover:opacity-100 classes for desktop hover', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        const uploadBtn = screen.getByLabelText('Upload cover');
        expect(uploadBtn).toHaveClass('opacity-0', 'group-hover:opacity-100');
      });

      it('upload icon container retains scale-90 and group-hover:scale-100 classes for desktop hover animation', () => {
        renderHero({ hasPath: true, onCoverFileSelect: vi.fn() });
        const uploadBtn = screen.getByLabelText('Upload cover');
        const iconContainer = uploadBtn.firstElementChild as HTMLElement;
        expect(iconContainer).toHaveClass('scale-90', 'group-hover:scale-100');
      });

      it('touch affordance classes are not present in DOM when hasPath is false', () => {
        renderHero({ hasPath: false, onCoverFileSelect: vi.fn() });
        expect(screen.queryByLabelText('Upload cover')).not.toBeInTheDocument();
      });

      it('touch affordance classes are not present in DOM when onCoverFileSelect is not provided', () => {
        renderHero({ hasPath: true });
        expect(screen.queryByLabelText('Upload cover')).not.toBeInTheDocument();
      });
    });
  });

  describe('Retry Import action (#635)', () => {
    it('shows Retry Import menu item when onRetryImportClick is provided', async () => {
      const user = userEvent.setup();
      renderHero({ onRetryImportClick: vi.fn() });

      // Open the overflow menu
      const moreBtn = screen.getByLabelText('More actions');
      await user.click(moreBtn);

      expect(screen.getByText('Retry Import')).toBeInTheDocument();
    });

    it('does not show Retry Import when onRetryImportClick is not provided', async () => {
      const user = userEvent.setup();
      renderHero();

      const moreBtn = screen.getByLabelText('More actions');
      await user.click(moreBtn);

      expect(screen.queryByText('Retry Import')).not.toBeInTheDocument();
    });

    it('calls onRetryImportClick when Retry Import is clicked', async () => {
      const user = userEvent.setup();
      const onRetryImportClick = vi.fn();
      renderHero({ onRetryImportClick });

      const moreBtn = screen.getByLabelText('More actions');
      await user.click(moreBtn);
      await user.click(screen.getByText('Retry Import'));

      expect(onRetryImportClick).toHaveBeenCalledTimes(1);
    });

    it('disables Retry Import button and shows Retrying... when isRetryingImport is true', async () => {
      const user = userEvent.setup();
      renderHero({ onRetryImportClick: vi.fn(), isRetryingImport: true });

      const moreBtn = screen.getByLabelText('More actions');
      await user.click(moreBtn);

      const retryBtn = screen.getByText('Retrying...');
      expect(retryBtn.closest('button')).toBeDisabled();
    });
  });
});
