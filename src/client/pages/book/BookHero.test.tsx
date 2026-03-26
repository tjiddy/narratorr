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
};

function renderHero(overrides = {}) {
  return render(
    <MemoryRouter>
      <BookHero {...defaultProps} {...overrides} />
    </MemoryRouter>,
  );
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

  it('renders author as link when authorAsin is provided', () => {
    renderHero({ authorAsin: 'B001IGFHW6' });
    const link = screen.getByRole('link', { name: 'Brandon Sanderson' });
    expect(link).toHaveAttribute('href', '/authors/B001IGFHW6');
  });

  it('renders author as plain text when no authorAsin', () => {
    renderHero({ authorAsin: null });
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brandon Sanderson' })).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    renderHero({ narratorNames: 'Michael Kramer, Kate Reading' });
    expect(screen.getByText('Narrated by Michael Kramer, Kate Reading')).toBeInTheDocument();
  });

  it('renders meta dots joined with separator', () => {
    renderHero({ metaDots: ['45h 0m', 'Fantasy'] });
    expect(screen.getByText('45h 0m · Fantasy')).toBeInTheDocument();
  });

  it('renders status badge', () => {
    renderHero();
    expect(screen.getByText('Wanted')).toBeInTheDocument();
  });

  it('renders cover image when coverUrl is provided', () => {
    renderHero();
    expect(screen.getByAltText('Cover of The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback icon when no coverUrl', () => {
    renderHero({ coverUrl: undefined });
    expect(screen.queryByAltText('Cover of The Way of Kings')).not.toBeInTheDocument();
  });

  it('calls onBackClick when Library button is clicked', async () => {
    const onBackClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onBackClick });

    await user.click(screen.getByText('Library'));
    expect(onBackClick).toHaveBeenCalledTimes(1);
  });

  it('calls onSearchClick when Search Releases button is clicked', async () => {
    const onSearchClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onSearchClick });

    await user.click(screen.getByText('Search Releases'));
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it('calls onEditClick when Edit button is clicked', async () => {
    const onEditClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onEditClick });

    await user.click(screen.getByText('Edit'));
    expect(onEditClick).toHaveBeenCalledTimes(1);
  });

  it('calls onRenameClick when Rename button is clicked', async () => {
    const onRenameClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onRenameClick });

    await user.click(screen.getByText('Rename'));
    expect(onRenameClick).toHaveBeenCalledTimes(1);
  });

  it('hides Rename button when book has no path', () => {
    renderHero({ hasPath: false });
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
  });

  it('disables Rename button when renaming is in progress', () => {
    renderHero({ isRenaming: true });
    expect(screen.getByText('Renaming...')).toBeInTheDocument();
    expect(screen.getByText('Renaming...').closest('button')).toBeDisabled();
  });

  it('calls onRetagClick when Re-tag button is clicked', async () => {
    const onRetagClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onRetagClick });

    await user.click(screen.getByText('Re-tag files'));
    expect(onRetagClick).toHaveBeenCalledTimes(1);
  });

  it('hides Re-tag button when book has no path', () => {
    renderHero({ hasPath: false });
    expect(screen.queryByText('Re-tag files')).not.toBeInTheDocument();
  });

  it('disables Re-tag button when re-tagging is in progress', () => {
    renderHero({ isRetagging: true });
    expect(screen.getByText('Re-tagging...')).toBeInTheDocument();
    expect(screen.getByText('Re-tagging...').closest('button')).toBeDisabled();
  });

  it('disables Re-tag button when retagDisabled is true', () => {
    renderHero({ retagDisabled: true, retagTooltip: 'Requires ffmpeg' });
    const button = screen.getByText('Re-tag files').closest('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Requires ffmpeg');
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

      // Background blur image (aria-hidden, alt="")
      const allImgs = document.querySelectorAll('img');
      const blurImg = Array.from(allImgs).find(
        img => img.getAttribute('aria-hidden') === 'true' && img.getAttribute('src')?.includes('/api/books/1/cover'),
      );
      expect(blurImg).toBeTruthy();
      expect(blurImg!.getAttribute('src')).toBe('/narratorr/api/books/1/cover');
    });
  });

  describe('merge button', () => {
    it('calls onMergeClick when Merge to M4B button is clicked', async () => {
      const onMergeClick = vi.fn();
      const user = userEvent.setup();
      renderHero({ canMerge: true, onMergeClick });

      await user.click(screen.getByRole('button', { name: /Merge to M4B/i }));
      expect(onMergeClick).toHaveBeenCalledTimes(1);
    });

    it('hides Merge to M4B button when canMerge is false', () => {
      renderHero({ canMerge: false });
      expect(screen.queryByRole('button', { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('hides Merge to M4B button when hasPath is false', () => {
      renderHero({ hasPath: false, canMerge: true });
      expect(screen.queryByRole('button', { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('shows "Merging..." text and disables button during isMerging', () => {
      renderHero({ canMerge: true, isMerging: true });
      const button = screen.getByRole('button', { name: /Merging\.\.\./i });
      expect(button).toBeDisabled();
    });

    it('disables button when mergeDisabled is true', () => {
      renderHero({ canMerge: true, mergeDisabled: true });
      const button = screen.getByRole('button', { name: /Merge to M4B/i });
      expect(button).toBeDisabled();
    });

    it('shows tooltip on button when mergeDisabled is true', () => {
      renderHero({ canMerge: true, mergeDisabled: true, mergeTooltip: 'ffmpeg not configured' });
      const button = screen.getByRole('button', { name: /Merge to M4B/i });
      expect(button).toHaveAttribute('title', 'ffmpeg not configured');
    });
  });

  describe('monitor toggle', () => {
    it('renders "Monitor" when monitorForUpgrades is false', () => {
      renderHero({ monitorForUpgrades: false });
      expect(screen.getByText('Monitor')).toBeInTheDocument();
    });

    it('renders "Monitoring" when monitorForUpgrades is true', () => {
      renderHero({ monitorForUpgrades: true });
      expect(screen.getByText('Monitoring')).toBeInTheDocument();
    });

    it('calls onMonitorToggle when clicked', async () => {
      const onMonitorToggle = vi.fn();
      const user = userEvent.setup();
      renderHero({ onMonitorToggle });

      await user.click(screen.getByText('Monitor'));
      expect(onMonitorToggle).toHaveBeenCalledTimes(1);
    });

    it('disables button when isMonitorToggling is true', () => {
      renderHero({ isMonitorToggling: true });
      const button = screen.getByText('Monitor').closest('button');
      expect(button).toBeDisabled();
    });

    it('shows active styling when monitoring', () => {
      renderHero({ monitorForUpgrades: true });
      const button = screen.getByText('Monitoring').closest('button');
      expect(button).toHaveAttribute('title', 'Monitoring for quality upgrades');
    });
  });
});
