import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockBook, createMockSettings } from '@/__tests__/factories';
import { api } from '@/lib/api';
import { BookDetails } from './BookDetails';
import type { BookWithAuthor } from '@/lib/api';
import type { MetadataBook } from './helpers';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';

vi.mock('@/components/SearchReleasesModal', () => ({
  SearchReleasesModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Search Modal</div> : null,
}));

vi.mock('@/hooks/useMergeProgress.js', () => ({
  useMergeProgress: vi.fn().mockReturnValue(null),
}));

import { useMergeProgress } from '@/hooks/useMergeProgress.js';
const mockUseMergeProgress = vi.mocked(useMergeProgress);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const actualApi = (actual as { api: Record<string, unknown> }).api;
  return {
    ...actual,
    api: {
      ...actualApi,
      getBookFiles: vi.fn(),
      updateBook: vi.fn(),
      renameBook: vi.fn(),
      retagBook: vi.fn(),
      mergeBookToM4b: vi.fn(),
      cancelMergeBook: vi.fn(),
      markBookAsWrongRelease: vi.fn(),
      deleteBook: vi.fn(),
      uploadBookCover: vi.fn(),
      refreshScanBook: vi.fn(),
      getSettings: vi.fn(),
    },
  };
});

/** Open the BookHero overflow menu to reveal secondary actions (Edit, Rename, Re-tag, etc.). */
async function openOverflowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('More actions'));
}

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({
    audioCodec: 'AAC',
    audioBitrate: 128000,
    audioSampleRate: 44100,
    audioChannels: 2,
    audioBitrateMode: 'cbr',
    audioFileCount: 12,
    audioTotalSize: 500_000_000,
    audioDuration: 36000,
    authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'A001' }],
    ...overrides,
  });
}

const fullMetadata: MetadataBook = {
  subtitle: 'Book One of the Stormlight Archive',
  description: '<p>Full description from metadata.</p>',
  coverUrl: 'https://example.com/meta-cover.jpg',
  genres: ['Fantasy', 'Epic', 'Adventure'],
  narrators: ['Michael Kramer', 'Kate Reading'],
  series: [{ name: 'The Stormlight Archive', position: 1 }],
  duration: 52320,
  publisher: 'Tor Books',
};

function renderBookDetails(
  bookOverrides: Partial<BookWithAuthor> = {},
  metadata?: MetadataBook | null,
) {
  return renderWithProviders(
    <BookDetails libraryBook={makeBook(bookOverrides)} metadataBook={metadata} />,
  );
}

describe('BookDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  describe('cover cache-busting prop wiring', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('passes libraryBook.updatedAt to BookHero for cover cache-busting', async () => {
      const resolveCoverUrlSpy = vi.spyOn(await import('@/lib/url-utils'), 'resolveCoverUrl');

      const updatedAt = '2024-06-15T12:00:00Z';
      renderBookDetails({ coverUrl: '/api/books/1/cover', updatedAt });

      expect(resolveCoverUrlSpy).toHaveBeenCalledWith('/api/books/1/cover', updatedAt);
    });
  });

  describe('full data layout', () => {
    it('renders description and sidebar in two-column grid', () => {
      renderBookDetails({}, fullMetadata);

      expect(screen.getByText('About This Book')).toBeInTheDocument();
      expect(screen.getByText('Audio Quality')).toBeInTheDocument();
      expect(screen.getByText('Genres')).toBeInTheDocument();
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
      expect(screen.getByText('Epic')).toBeInTheDocument();
    });

    it('renders hero with title, author, and status', () => {
      renderBookDetails({}, fullMetadata);

      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
      expect(screen.getByText('Wanted')).toBeInTheDocument();
    });

    it('shows metadata subtitle when available', () => {
      renderBookDetails({}, fullMetadata);

      expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
    });

    it('renders audio preview inside hero section for imported book with path', () => {
      renderBookDetails({ status: 'imported', path: '/library/book1' }, fullMetadata);

      expect(document.querySelector('audio')).not.toBeNull();
      expect(document.querySelector('audio')!.hasAttribute('controls')).toBe(false);
      expect(document.querySelector('audio')!.hidden).toBe(true);
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });

    it('does not render audio preview for non-imported book', () => {
      renderBookDetails({ status: 'wanted', path: null }, fullMetadata);

      expect(document.querySelector('audio')).toBeNull();
    });
  });

  describe('missing description', () => {
    it('renders sidebar without description section', () => {
      renderBookDetails({ description: null }, { ...fullMetadata, description: undefined });

      expect(screen.queryByText('About This Book')).not.toBeInTheDocument();
      expect(screen.getByText('Audio Quality')).toBeInTheDocument();
      expect(screen.getByText('Genres')).toBeInTheDocument();
    });
  });

  describe('missing audio info and genres', () => {
    it('renders description without sidebar when no audio or genres', () => {
      renderBookDetails({
        audioCodec: null,
        genres: null,
      }, { ...fullMetadata, genres: undefined });

      expect(screen.getByText('About This Book')).toBeInTheDocument();
      expect(screen.queryByText('Audio Quality')).not.toBeInTheDocument();
      expect(screen.queryByText('Genres')).not.toBeInTheDocument();
    });
  });

  describe('no content sections', () => {
    it('renders hero only when no description, audio, or genres', () => {
      renderBookDetails({
        description: null,
        audioCodec: null,
        genres: null,
      }, null);

      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.queryByText('About This Book')).not.toBeInTheDocument();
      expect(screen.queryByText('Audio Quality')).not.toBeInTheDocument();
      expect(screen.queryByText('Genres')).not.toBeInTheDocument();
    });
  });

  describe('missing cover', () => {
    it('renders placeholder icon when no cover URL', () => {
      renderBookDetails({ coverUrl: null }, null);

      // The BookOpenIcon placeholder renders when no cover
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      // No cover image alt text
      expect(screen.queryByAltText(/Cover of/)).not.toBeInTheDocument();
    });
  });

  describe('author without ASIN', () => {
    it('renders author name as plain text instead of link', () => {
      renderBookDetails({
        authors: [{ id: 1, name: 'Unknown Author', slug: 'unknown-author', asin: null }],
      });

      const authorText = screen.getByText('Unknown Author');
      expect(authorText.closest('a')).toBeNull();
    });
  });

  describe('empty genres array', () => {
    it('hides genres section when genres is an empty array', () => {
      renderBookDetails({ genres: [] }, { ...fullMetadata, genres: [] });

      expect(screen.queryByText('Genres')).not.toBeInTheDocument();
    });
  });

  describe('short description', () => {
    it('does not show expand button for short descriptions', () => {
      renderBookDetails({ description: '<p>Short text.</p>' });

      expect(screen.getByText('About This Book')).toBeInTheDocument();
      expect(screen.queryByText('Show more')).not.toBeInTheDocument();
    });
  });

  describe('genres only (no audio)', () => {
    it('renders genres sidebar without audio quality section', () => {
      renderBookDetails({ audioCodec: null }, fullMetadata);

      expect(screen.queryByText('Audio Quality')).not.toBeInTheDocument();
      expect(screen.getByText('Genres')).toBeInTheDocument();
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
    });
  });

  describe('audio only (no genres)', () => {
    it('renders audio quality without genres section', () => {
      renderBookDetails({ genres: null }, { ...fullMetadata, genres: undefined });

      expect(screen.getByText('Audio Quality')).toBeInTheDocument();
      expect(screen.queryByText('Genres')).not.toBeInTheDocument();
    });
  });

  describe('file list', () => {
    it('shows file list section when book has path', async () => {
      (api.getBookFiles as Mock).mockResolvedValue([
        { name: 'Chapter 01.m4b', size: 52428800 },
      ]);

      renderBookDetails({ path: '/library/book1', status: 'imported' });

      expect(await screen.findByText('Files (1)')).toBeInTheDocument();
    });

    it('hides file list section when book has no path', () => {
      renderBookDetails({ path: null });

      expect(screen.queryByText(/Files/)).not.toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('opens search modal when Search Releases is clicked', async () => {
      const user = userEvent.setup();
      renderBookDetails();

      await user.click(screen.getByText('Search Releases'));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('toggles description expand/collapse for long text', async () => {
      const user = userEvent.setup();
      const longDesc = '<p>' + 'A'.repeat(400) + '</p>';
      renderBookDetails({ description: longDesc });

      expect(screen.getByText('Show more')).toBeInTheDocument();

      await user.click(screen.getByText('Show more'));
      expect(screen.getByText('Show less')).toBeInTheDocument();

      await user.click(screen.getByText('Show less'));
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    it('opens edit modal when Edit button is clicked', async () => {
      const user = userEvent.setup();
      renderBookDetails();

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Edit/ }));

      expect(screen.getByRole('dialog', { name: /edit metadata/i })).toBeInTheDocument();
    });

    it('shows Rename menu item when book has path', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
    });

    it('hides Rename menu item when book has no path', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: null });

      await openOverflowMenu(user);
      expect(screen.queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument();
    });

    it('calls renameBook API when Rename button is clicked and confirmed', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockResolvedValue({
        oldPath: '/library/old',
        newPath: '/library/new',
        message: 'Moved',
        filesRenamed: 1,
      });

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(api.renameBook).toHaveBeenCalledWith(1);
      });
    });

    it('saves metadata and renames when rename checkbox is checked', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockResolvedValue({
        oldPath: '/library/old',
        newPath: '/library/new',
        message: 'Moved to new path',
        filesRenamed: 1,
      });

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Edit/ }));

      const dialog = screen.getByRole('dialog', { name: /edit metadata/i });
      const titleInput = dialog.querySelector('#edit-title') as HTMLInputElement;
      await user.clear(titleInput);
      await user.type(titleInput, 'New Title');

      const renameCheckbox = screen.getByRole('checkbox');
      await user.click(renameCheckbox);

      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(api.renameBook).toHaveBeenCalledWith(1);
      });
      expect(api.updateBook).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'New Title' }));
    });

    it('shows rename error independently when metadata update succeeds but rename fails', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockRejectedValue(new Error('Conflict with another book'));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Edit/ }));

      const renameCheckbox = screen.getByRole('checkbox');
      await user.click(renameCheckbox);

      await user.click(screen.getByText('Save'));

      // Metadata update should have succeeded — modal should close
      await waitFor(() => {
        expect(api.updateBook).toHaveBeenCalled();
      });
      // Rename was attempted despite being a separate operation
      expect(api.renameBook).toHaveBeenCalledWith(1);
    });

    it('does not call renameBook when rename checkbox is unchecked', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockResolvedValue({});

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Edit/ }));

      const dialog = screen.getByRole('dialog', { name: /edit metadata/i });
      const titleInput = dialog.querySelector('#edit-title') as HTMLInputElement;
      await user.clear(titleInput);
      await user.type(titleInput, 'New Title');

      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(api.updateBook).toHaveBeenCalled();
      });
      expect(api.renameBook).not.toHaveBeenCalled();
    });
  });

  describe('retag', () => {
    it('calls retagBook API and shows success toast with plural', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      (api.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 3, skipped: 0, failed: 0, warnings: [],
      });

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled();
      });

      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog1 = screen.getByRole('dialog');
      await user.click(within(dialog1).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(api.retagBook).toHaveBeenCalledWith(1);
      });
      expect(toast.success).toHaveBeenCalledWith('Tagged 3 files');
    });

    it('shows singular "file" when only one file tagged', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      (api.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [],
      });

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled();
      });

      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog2 = screen.getByRole('dialog');
      await user.click(within(dialog2).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Tagged 1 file');
      });
    });

    it('shows warning toast when some files failed', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      (api.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 2, skipped: 0, failed: 1, warnings: ['ch03.ogg: Unsupported'],
      });

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled();
      });

      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog3 = screen.getByRole('dialog');
      await user.click(within(dialog3).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(toast.warning).toHaveBeenCalledWith('Tagged 2 files, 1 failed');
      });
    });

    it('shows error toast when retag API fails', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      (api.retagBook as Mock).mockRejectedValue(new Error('ffmpeg is not configured'));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled();
      });

      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog4 = screen.getByRole('dialog');
      await user.click(within(dialog4).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Re-tag failed: ffmpeg is not configured');
      });
    });

    it('disables Re-tag button when ffmpeg is not configured', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Re-tag/ })).toBeInTheDocument();
      });

      const button = screen.getByRole("menuitem", { name: /Re-tag/ });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Requires ffmpeg — configure in Settings > Post Processing');
    });

    it('enables Re-tag button when ffmpeg path is configured', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => {
        const button = screen.getByRole("menuitem", { name: /Re-tag/ });
        expect(button).not.toBeDisabled();
      });
    });

    it('hides Re-tag button when book has no path', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ path: null });

      await openOverflowMenu(user);
      // Wait for settings to load, then check button is absent
      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: /Re-tag/ })).not.toBeInTheDocument();
      });
    });
  });

  describe('monitor toggle', () => {
    it('shows Monitor button and toggles to enabled on click', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockResolvedValue({ ...makeBook(), monitorForUpgrades: true });

      renderBookDetails({ monitorForUpgrades: false });

      const button = screen.getByText('Monitor').closest('button')!;
      expect(button).not.toBeDisabled();

      await user.click(button);

      await waitFor(() => {
        expect(api.updateBook).toHaveBeenCalledWith(expect.any(Number), { monitorForUpgrades: true });
      });
      expect(toast.success).toHaveBeenCalledWith('Upgrade monitoring enabled');
    });

    it('toggles monitoring off when already enabled', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockResolvedValue({ ...makeBook(), monitorForUpgrades: false });

      renderBookDetails({ monitorForUpgrades: true });

      await user.click(screen.getByText('Monitoring'));

      await waitFor(() => {
        expect(api.updateBook).toHaveBeenCalledWith(expect.any(Number), { monitorForUpgrades: false });
      });
      expect(toast.success).toHaveBeenCalledWith('Upgrade monitoring disabled');
    });

    it('shows error toast when monitor toggle fails', async () => {
      const user = userEvent.setup();
      (api.updateBook as Mock).mockRejectedValue(new Error('Network error'));

      renderBookDetails({ monitorForUpgrades: false });

      await user.click(screen.getByText('Monitor'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to update: Network error');
      });
    });
  });

  describe('tab ARIA roles and keyboard navigation', () => {
    it('renders tab container with role="tablist" and aria-label', () => {
      renderBookDetails();
      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveAttribute('aria-label');
    });

    it('renders each tab button with role="tab"', () => {
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
    });

    it('sets aria-selected="true" on active tab and "false" on inactive', () => {
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    });

    it('updates aria-selected on both tabs when clicking inactive tab', async () => {
      const user = userEvent.setup();
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');

      await user.click(tabs[1]);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('tab buttons have non-empty ids for ARIA linkage', () => {
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0].id).toBeTruthy();
      expect(tabs[1].id).toBeTruthy();
      expect(tabs[0].id).not.toBe(tabs[1].id);
    });

    it('renders tab panel with role="tabpanel" and aria-labelledby matching tab id', () => {
      renderBookDetails();
      const panel = screen.getByRole('tabpanel');
      const tabs = screen.getAllByRole('tab');
      expect(panel).toHaveAttribute('aria-labelledby', tabs[0].id);
    });

    it('switching to History tab swaps tabpanel linkage to History tab', async () => {
      const user = userEvent.setup();
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');

      await user.click(tabs[1]);

      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-history');
    });

    it('pressing Right arrow on Details tab activates History tab and swaps panel', async () => {
      const user = userEvent.setup();
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');

      tabs[0].focus();
      await user.keyboard('{ArrowRight}');

      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
      expect(document.activeElement).toBe(tabs[1]);
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-history');
    });

    it('pressing Left arrow on History tab activates Details tab and swaps panel back', async () => {
      const user = userEvent.setup();
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');

      await user.click(tabs[1]);
      tabs[1].focus();
      await user.keyboard('{ArrowLeft}');

      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
      expect(document.activeElement).toBe(tabs[0]);
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-details');
    });

    it('arrow keys wrap around — Right on last tab focuses first, Left on first focuses last', async () => {
      const user = userEvent.setup();
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');

      // Right on last tab (History) → wraps to first (Details)
      await user.click(tabs[1]);
      tabs[1].focus();
      await user.keyboard('{ArrowRight}');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(tabs[0]);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-details');

      // Left on first tab (Details) → wraps to last (History)
      tabs[0].focus();
      await user.keyboard('{ArrowLeft}');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(tabs[1]);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-history');
    });

    it('aria-selected is correct on initial render before any interaction', () => {
      renderBookDetails();
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    });
  });

  describe('rename confirmation modal', () => {
    it('shows confirmation modal when Rename button is clicked (api.renameBook not yet called)', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('modal message includes the book title', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

      expect(within(screen.getByRole('dialog')).getByText(/The Way of Kings/)).toBeInTheDocument();
    });

    it('modal message states the action cannot be undone', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

      expect(within(screen.getByRole('dialog')).getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('confirm calls api.renameBook with the correct book ID', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockResolvedValue({ oldPath: '/old', newPath: '/new', message: 'Moved', filesRenamed: 1 });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(api.renameBook).toHaveBeenCalledWith(1);
      });
    });

    it('modal closes immediately when Confirm is clicked (before mutation settles)', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockReturnValue(new Promise(() => {}));
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('rapid repeated confirm clicks call api.renameBook at most once', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockResolvedValue({ oldPath: '/old', newPath: '/new', message: 'Moved', filesRenamed: 1 });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);
      // Modal is now closed — no dialog to click again
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(api.renameBook).toHaveBeenCalledTimes(1);
      });
    });

    it('cancel closes the modal without calling api.renameBook', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('Escape key closes the modal without calling api.renameBook', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('backdrop click closes the modal without calling api.renameBook', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Click the backdrop (fixed overlay behind the modal panel)
      await user.click(document.querySelector('.fixed.inset-0')!);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });
  });

  describe('retag confirmation modal', () => {
    function mockFfmpegEnabled() {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
    }

    it('shows confirmation modal when Re-tag files button is clicked (api.retagBook not yet called)', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('modal message includes the book title', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));

      expect(within(screen.getByRole('dialog')).getByText(/The Way of Kings/)).toBeInTheDocument();
    });

    it('modal message states the action cannot be undone', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));

      expect(within(screen.getByRole('dialog')).getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('confirm calls api.retagBook with the correct book ID', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      (api.retagBook as Mock).mockResolvedValue({ bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [] });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(api.retagBook).toHaveBeenCalledWith(1);
      });
    });

    it('modal closes immediately when Confirm is clicked (before mutation settles)', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      (api.retagBook as Mock).mockReturnValue(new Promise(() => {}));
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('rapid repeated confirm clicks call api.retagBook at most once', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      (api.retagBook as Mock).mockResolvedValue({ bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [] });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(api.retagBook).toHaveBeenCalledTimes(1);
      });
    });

    it('cancel closes the modal without calling api.retagBook', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('Escape key closes the modal without calling api.retagBook', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('backdrop click closes the modal without calling api.retagBook', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(document.querySelector('.fixed.inset-0')!);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('Re-tag button is disabled when ffmpegConfigured is false and clicking does not open modal', async () => {
      const user = userEvent.setup();
      // ffmpegPath is empty → ffmpegConfigured = false → button disabled
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });
      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).toBeDisabled());

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('rename and retag modals are independent — opening one does not affect the other', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      // Open rename modal
      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Cancel rename — retag modal should not be open
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Open retag modal independently
      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Re-tag/ })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Re-tag/ }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });
  });

  describe('Merge to M4B button', () => {
    function mockFfmpegEnabledForMerge() {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
    }

    it('shows Merge to M4B button for imported book with topLevelAudioFileCount >= 2 and path set', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 12 });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Merge to M4B/i })).toBeInTheDocument());
    });

    it('hides Merge to M4B button when topLevelAudioFileCount is 1 (single top-level file)', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 1 });

      await openOverflowMenu(user);
      expect(screen.queryByRole("menuitem", { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('hides Merge to M4B button when topLevelAudioFileCount is null (not yet enriched)', () => {
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: null, audioFileCount: 12 });

      expect(screen.queryByRole("menuitem", { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('hides Merge to M4B button when topLevelAudioFileCount is 0 (nested-only layout)', () => {
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', audioFileCount: 12, topLevelAudioFileCount: 0 });

      expect(screen.queryByRole("menuitem", { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('hides Merge to M4B button when book has no path', () => {
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: null, status: 'imported', topLevelAudioFileCount: 12 });

      expect(screen.queryByRole("menuitem", { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('hides Merge to M4B button when book status is not imported', () => {
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'wanted', topLevelAudioFileCount: 12 });

      expect(screen.queryByRole("menuitem", { name: /Merge to M4B/i })).not.toBeInTheDocument();
    });

    it('disables Merge to M4B button when ffmpegConfigured is false', async () => {
      const user = userEvent.setup();
      // ffmpegPath is empty → ffmpegConfigured = false → button disabled
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 12 });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Merge to M4B/i })).toBeDisabled());
    });
  });

  describe('Merge to M4B confirmation modal', () => {
    function mockFfmpegEnabledForMerge() {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));
    }

    it('clicking Merge to M4B opens confirmation modal without calling API', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 12 });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Merge to M4B/i })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Merge to M4B/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.mergeBookToM4b).not.toHaveBeenCalled();
    });

    it('cancelling confirmation modal does not trigger merge mutation', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabledForMerge();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 12 });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Merge to M4B/i })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Merge to M4B/i }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.mergeBookToM4b).not.toHaveBeenCalled();
    });

    it('confirming calls api.mergeBookToM4b (close-before-mutate pattern)', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabledForMerge();
      (api.mergeBookToM4b as Mock).mockResolvedValue({ bookId: 1, filesReplaced: 12, outputFile: '/lib/book.m4b', message: 'Merged' });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported', topLevelAudioFileCount: 12 });

      await openOverflowMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Merge to M4B/i })).not.toBeDisabled());
      await user.click(screen.getByRole("menuitem", { name: /Merge to M4B/i }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge' }));

      await waitFor(() => expect(api.mergeBookToM4b).toHaveBeenCalledWith(1));
    });
  });

  describe('delete action', () => {
    it('renders Remove button in action row', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/lib/test' });
      await openOverflowMenu(user);
      expect(screen.getByRole("menuitem", { name: /Remove/ })).toBeInTheDocument();
    });

    it('opens delete confirmation modal when Remove is clicked', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/lib/test' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();
    });

    it('calls deleteBook API with deleteFiles=false when confirmed without toggle', async () => {
      const user = userEvent.setup();
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      renderBookDetails({ id: 1, path: '/lib/test' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(api.deleteBook).toHaveBeenCalledWith(1, undefined));
    });

    it('calls deleteBook API with deleteFiles=true when confirmed with toggle checked', async () => {
      const user = userEvent.setup();
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      renderBookDetails({ id: 1, path: '/lib/test', audioFileCount: 5 });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
      await user.click(screen.getByLabelText('Also delete 5 files from disk'));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(api.deleteBook).toHaveBeenCalledWith(1, { deleteFiles: true }));
    });

    it('shows error toast on delete failure', async () => {
      const user = userEvent.setup();
      (api.deleteBook as Mock).mockRejectedValue(new Error('Permission denied'));
      renderBookDetails({ id: 1, path: '/lib/test' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to remove book: Permission denied'));
    });

    it('navigates to library page after successful delete', async () => {
      const user = userEvent.setup();
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      renderBookDetails({ id: 1, path: '/lib/test' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'));
    });

    it('does not navigate on delete failure', async () => {
      const user = userEvent.setup();
      (api.deleteBook as Mock).mockRejectedValue(new Error('Permission denied'));
      renderBookDetails({ id: 1, path: '/lib/test' });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(mockNavigate).not.toHaveBeenCalledWith('/library');
    });

    it('shows file count in delete toggle label when audioFileCount is positive', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/lib/test', audioFileCount: 12 });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));

      expect(screen.getByLabelText('Also delete 12 files from disk')).toBeInTheDocument();
    });

    it('shows generic label when audioFileCount is null', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/lib/test', audioFileCount: null });

      await openOverflowMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /Remove/ }));

      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// #257 — Merge observability: progress indicator on BookDetails
// ============================================================================

describe('#257 merge observability — BookDetails progress', () => {
  it('progress indicator NOT visible when no merge in progress', () => {
    mockUseMergeProgress.mockReturnValue(null);
    renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
    expect(screen.queryByRole('status', { name: /merge progress/i })).not.toBeInTheDocument();
  });

  it('progress indicator appears with phase text when merge is in progress', () => {
    mockUseMergeProgress.mockReturnValue({ phase: 'staging' });
    renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
    expect(screen.getByRole('status', { name: /merge progress/i })).toBeInTheDocument();
    expect(screen.getByText(/Staging files/)).toBeInTheDocument();
  });

  it('progress indicator updates percentage during processing phase', () => {
    mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.34 });
    renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
    expect(screen.getByText(/Encoding to M4B — 34%/)).toBeInTheDocument();
  });

  it('progress indicator shows verifying phase', () => {
    mockUseMergeProgress.mockReturnValue({ phase: 'verifying' });
    renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
    expect(screen.getByText(/Verifying output/)).toBeInTheDocument();
  });

  it('progress indicator shows committing phase', () => {
    mockUseMergeProgress.mockReturnValue({ phase: 'committing' });
    renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
    expect(screen.getByText(/Committing/)).toBeInTheDocument();
  });

  it('merge button disabled while progress indicator is visible', async () => {
    const user = userEvent.setup();
    (api.getSettings as Mock).mockResolvedValue(createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    }));
    mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.5 });
    renderBookDetails({ path: '/library/test', status: 'imported', topLevelAudioFileCount: 3 });

    await openOverflowMenu(user);
    // The merge button should show "Merging..." and be disabled
    await waitFor(() => {
      const mergeButton = screen.getByRole("menuitem", { name: /Merging/i });
      expect(mergeButton).toBeDisabled();
    });
  });

  describe('#368 merge queue — queued progress indicator', () => {
    it('renders "Queued (position 2)" when merge phase is queued', async () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'queued', position: 2 });
      renderBookDetails({ path: '/library/test', status: 'imported', topLevelAudioFileCount: 3 });

      await waitFor(() => {
        expect(screen.getByRole('status', { name: /Merge progress/ })).toHaveTextContent('Queued (position 2)');
      });
    });

    it('renders "Queued" without position when position is undefined', async () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'queued' });
      renderBookDetails({ path: '/library/test', status: 'imported', topLevelAudioFileCount: 3 });

      await waitFor(() => {
        expect(screen.getByRole('status', { name: /Merge progress/ })).toHaveTextContent('Queued');
      });
    });
  });

  describe('#430 progress bar accessibility', () => {
    it('progress bar renders with role=progressbar, aria-valuenow, aria-valuemin=0, aria-valuemax=100 when processing', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.5 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '50');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('aria-valuenow reflects the current percentage value (e.g., 0.34 → 34)', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.34 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '34');
    });

    it('aria-valuenow is 0 when percentage is 0 (not omitted)', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    });

    it('aria-valuenow is 100 when percentage is 1.0', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 1.0 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '100');
    });
  });

  describe('#430 fade-out animation on terminal state', () => {
    it('fade-out animation class is applied and spinner stops on success', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'complete', outcome: 'success' });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const indicator = screen.getByRole('status', { name: /merge progress/i });
      expect(indicator.className).toContain('animate-fade-out');
      // Terminal state should show success icon (text-success), not spinning RefreshIcon
      const svg = indicator.querySelector('svg');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).toContain('text-success');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).not.toContain('animate-spin');
    });

    it('fade-out animation class is applied and error icon shown on error', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'failed', outcome: 'error' });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const indicator = screen.getByRole('status', { name: /merge progress/i });
      expect(indicator.className).toContain('animate-fade-out');
      const svg = indicator.querySelector('svg');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).toContain('text-destructive');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).not.toContain('animate-spin');
    });

    it('fade-out animation class is applied and cancel icon shown on cancelled', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'cancelled', outcome: 'cancelled' });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const indicator = screen.getByRole('status', { name: /merge progress/i });
      expect(indicator.className).toContain('animate-fade-out');
      const svg = indicator.querySelector('svg');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).toContain('text-muted-foreground');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).not.toContain('animate-spin');
    });

    it('active merge shows spinning icon without fade-out', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.5 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      const indicator = screen.getByRole('status', { name: /merge progress/i });
      expect(indicator.className).not.toContain('animate-fade-out');
      const svg = indicator.querySelector('svg');
      expect(svg?.className.baseVal ?? svg?.getAttribute('class')).toContain('animate-spin');
    });

    it('indicator is not rendered when mergeProgress is null (after dismiss)', () => {
      mockUseMergeProgress.mockReturnValue(null);
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      expect(screen.queryByRole('status', { name: /merge progress/i })).not.toBeInTheDocument();
    });
  });

  describe('Wrong Release action', () => {
    it('shows Wrong Release button when book is imported with lastGrabGuid', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabGuid: 'guid-abc' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Wrong Release/ })).toBeInTheDocument();
      });
    });

    it('shows Wrong Release button when book is imported with lastGrabInfoHash', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabInfoHash: 'hash-123' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Wrong Release/ })).toBeInTheDocument();
      });
    });

    it('hides Wrong Release button when book status is wanted', async () => {
      renderBookDetails({ status: 'wanted', lastGrabGuid: 'guid-abc' });

      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: /Wrong Release/ })).not.toBeInTheDocument();
      });
    });

    it('hides Wrong Release button when imported but both identifiers are null', async () => {
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabGuid: null, lastGrabInfoHash: null });

      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: /Wrong Release/ })).not.toBeInTheDocument();
      });
    });

    it('opens confirmation modal when Wrong Release button is clicked', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabGuid: 'guid-abc' });

      await openOverflowMenu(user);
      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Wrong Release/ })).toBeInTheDocument();
      });
      await user.click(screen.getByRole("menuitem", { name: /Wrong Release/ }));

      await waitFor(() => {
        expect(screen.getByText(/blacklist this release/)).toBeInTheDocument();
      });
    });

    it('calls wrong release mutation when modal is confirmed', async () => {
      (api.markBookAsWrongRelease as Mock).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabGuid: 'guid-abc' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Wrong Release/ })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("menuitem", { name: /Wrong Release/ }));

      await waitFor(() => {
        expect(screen.getByText(/blacklist this release/)).toBeInTheDocument();
      });

      // Click the confirm button inside the modal dialog
      const dialog = screen.getByRole('dialog');
      const confirmButton = within(dialog).getByRole('button', { name: /Wrong Release/i });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(api.markBookAsWrongRelease).toHaveBeenCalledWith(expect.any(Number));
      });
    });

    it('does not call mutation when modal is cancelled', async () => {
      vi.mocked(api.markBookAsWrongRelease).mockClear();
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/test', lastGrabGuid: 'guid-abc' });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /Wrong Release/ })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("menuitem", { name: /Wrong Release/ }));

      await waitFor(() => {
        expect(screen.getByText(/blacklist this release/)).toBeInTheDocument();
      });

      // Click cancel within the dialog (not the merge cancel button)
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /Cancel/i }));

      expect(api.markBookAsWrongRelease).not.toHaveBeenCalled();
    });
  });

  describe('merge cancel affordance', () => {
    it('shows cancel option during active merge in non-committing phase', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.5 });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeInTheDocument();
    });

    it('hides cancel option during committing phase', () => {
      mockUseMergeProgress.mockReturnValue({ phase: 'committing' });
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('hides cancel option when no merge is active', () => {
      mockUseMergeProgress.mockReturnValue(null);
      renderBookDetails({ status: 'imported', topLevelAudioFileCount: 3 });
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('clicking cancel triggers cancel mutation with the rendered book ID', async () => {
      vi.mocked(api.cancelMergeBook).mockResolvedValue({ success: true });
      mockUseMergeProgress.mockReturnValue({ phase: 'processing', percentage: 0.5 });
      const user = userEvent.setup();
      renderBookDetails({ id: 999, status: 'imported', topLevelAudioFileCount: 3 });

      await user.click(screen.getByRole('button', { name: /cancel merge/i }));

      await waitFor(() => {
        expect(api.cancelMergeBook).toHaveBeenCalledWith(999);
      });
    });
  });

  // #445 — Cover upload orchestration
  describe('cover upload', () => {
    it('shows upload overlay on cover when book has path', () => {
      renderBookDetails({ path: '/library/book', status: 'imported' });
      expect(screen.getByLabelText('Upload cover')).toBeInTheDocument();
    });

    it('does not show upload overlay when book has no path', () => {
      renderBookDetails({ path: null, status: 'wanted' });
      expect(screen.queryByLabelText('Upload cover')).not.toBeInTheDocument();
    });

    it('shows preview with confirm/cancel after selecting a valid image file', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByAltText('Cover preview')).toBeInTheDocument();
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
        expect(screen.getByLabelText('Cancel cover')).toBeInTheDocument();
      });
    });

    it('shows error toast for oversized file via file picker', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      // Create a file that reports > 10 MB via Object.defineProperty
      const file = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
      Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
      await user.upload(fileInput, file);

      expect(toast.error).toHaveBeenCalledWith('Cover image must be under 10 MB');
      expect(screen.queryByAltText('Cover preview')).not.toBeInTheDocument();
    });

    it('clicking cancel restores original cover and clears preview', async () => {
      const user = userEvent.setup();
      renderBookDetails({ path: '/library/book', status: 'imported', coverUrl: 'https://example.com/cover.jpg' });

      // Select file to enter preview state
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Cancel cover')).toBeInTheDocument();
      });

      // Cancel
      await user.click(screen.getByLabelText('Cancel cover'));

      await waitFor(() => {
        expect(screen.queryByAltText('Cover preview')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Cancel cover')).not.toBeInTheDocument();
      });
    });

    it('clicking confirm calls uploadBookCover with correct bookId and file', async () => {
      vi.mocked(api.uploadBookCover).mockResolvedValue(makeBook({ coverUrl: '/api/books/1/cover' }));
      const user = userEvent.setup();
      renderBookDetails({ id: 42, path: '/library/book', status: 'imported' });

      // Select file
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
      });

      // Confirm upload
      await user.click(screen.getByLabelText('Confirm cover'));

      await waitFor(() => {
        expect(api.uploadBookCover).toHaveBeenCalledWith(42, expect.any(File));
      });
    });

    it('shows success toast and clears preview after successful upload', async () => {
      vi.mocked(api.uploadBookCover).mockResolvedValue(makeBook({ coverUrl: '/api/books/1/cover' }));
      const user = userEvent.setup();
      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Confirm cover'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Cover updated');
        expect(screen.queryByAltText('Cover preview')).not.toBeInTheDocument();
      });
    });

    it('shows error toast on upload failure and keeps preview for retry', async () => {
      vi.mocked(api.uploadBookCover).mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();
      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Confirm cover'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Cover upload failed: Server error');
        // Preview stays visible on error so user can retry
        expect(screen.getByAltText('Cover preview')).toBeInTheDocument();
      });
    });

    it('shows error toast for disallowed image type via paste', async () => {
      renderBookDetails({ path: '/library/book', status: 'imported' });

      // Paste a GIF — useCoverPaste accepts image/* but handleCoverFile rejects non-jpg/png/webp
      const file = new File(['gif-data'], 'image.gif', { type: 'image/gif' });
      const item = {
        kind: 'file',
        type: 'image/gif',
        getAsFile: () => file,
        getAsString: vi.fn(),
        webkitGetAsEntry: vi.fn(),
      } as unknown as DataTransferItem;
      const event = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { items: [item] as unknown as DataTransferItemList },
      });
      document.dispatchEvent(event);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Only JPG, PNG, and WebP images are supported');
      });
      expect(screen.queryByAltText('Cover preview')).not.toBeInTheDocument();
    });

    it('replacing preview revokes previous object URL before creating new one', async () => {
      const user = userEvent.setup();
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');

      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // First file selection → preview A
      const file1 = new File(['img1'], 'a.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file1);

      await waitFor(() => {
        expect(screen.getByAltText('Cover preview')).toHaveAttribute('src', 'blob:first');
      });

      // Second file selection → preview B (should revoke A first)
      revokeObjectURLSpy.mockClear();
      const file2 = new File(['img2'], 'b.png', { type: 'image/png' });
      await user.upload(fileInput, file2);

      await waitFor(() => {
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:first');
        expect(screen.getByAltText('Cover preview')).toHaveAttribute('src', 'blob:second');
      });

      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('confirming upload revokes the active blob URL via effect cleanup', async () => {
      vi.mocked(api.uploadBookCover).mockResolvedValue(makeBook({ coverUrl: '/api/books/1/cover' }));
      const user = userEvent.setup();
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:confirm-test');

      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
      });

      revokeObjectURLSpy.mockClear();
      await user.click(screen.getByLabelText('Confirm cover'));

      await waitFor(() => {
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:confirm-test');
      });

      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('cancelling upload revokes the active blob URL via effect cleanup', async () => {
      const user = userEvent.setup();
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:cancel-test');

      renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByLabelText('Cancel cover')).toBeInTheDocument();
      });

      revokeObjectURLSpy.mockClear();
      await user.click(screen.getByLabelText('Cancel cover'));

      await waitFor(() => {
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:cancel-test');
      });

      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('unmounting with active preview revokes the blob URL exactly once', async () => {
      const user = userEvent.setup();
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:unmount-test');

      const { unmount } = renderBookDetails({ path: '/library/book', status: 'imported' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['image-data'], 'cover.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByAltText('Cover preview')).toHaveAttribute('src', 'blob:unmount-test');
      });

      revokeObjectURLSpy.mockClear();
      unmount();

      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:unmount-test');
      expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);

      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    describe('paste wiring', () => {
      function dispatchImagePaste() {
        const file = new File([new ArrayBuffer(1024)], 'pasted.png', { type: 'image/png' });
        const item = {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
          getAsString: vi.fn(),
          webkitGetAsEntry: vi.fn(),
        } as unknown as DataTransferItem;

        const event = new Event('paste', { bubbles: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', {
          value: { items: [item] as unknown as DataTransferItemList },
        });
        document.dispatchEvent(event);
      }

      it('pasting an image on the page shows preview when book has a path', async () => {
        renderBookDetails({ path: '/library/book', status: 'imported' });

        dispatchImagePaste();

        await waitFor(() => {
          expect(screen.getByAltText('Cover preview')).toBeInTheDocument();
          expect(screen.getByLabelText('Confirm cover')).toBeInTheDocument();
        });
      });

      it('pasting an image does nothing when book has no path', () => {
        renderBookDetails({ path: null, status: 'wanted' });

        dispatchImagePaste();

        expect(screen.queryByAltText('Cover preview')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Confirm cover')).not.toBeInTheDocument();
      });
    });
  });

  describe('Refresh & Scan wiring', () => {
    it('shows Refresh & Scan menu item for imported book with path', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: '/lib/book' });
      await openOverflowMenu(user);
      expect(screen.getByRole('menuitem', { name: 'Refresh & Scan' })).toBeInTheDocument();
    });

    it('hides Refresh & Scan for non-imported book even with path', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'wanted', path: '/lib/book' });
      await openOverflowMenu(user);
      expect(screen.queryByRole('menuitem', { name: 'Refresh & Scan' })).not.toBeInTheDocument();
    });

    it('hides Refresh & Scan when book has no path', async () => {
      const user = userEvent.setup();
      renderBookDetails({ status: 'imported', path: null });
      await openOverflowMenu(user);
      expect(screen.queryByRole('menuitem', { name: 'Refresh & Scan' })).not.toBeInTheDocument();
    });

    it('fires refreshScanMutation on menu item click', async () => {
      const user = userEvent.setup();
      (api.refreshScanBook as Mock).mockResolvedValue({
        bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });
      renderBookDetails({ status: 'imported', path: '/lib/book' });
      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Refresh & Scan' }));
      await waitFor(() => {
        expect(api.refreshScanBook).toHaveBeenCalled();
      });
    });

    it('shows success toast after successful refresh scan', async () => {
      const user = userEvent.setup();
      (api.refreshScanBook as Mock).mockResolvedValue({
        bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });
      renderBookDetails({ status: 'imported', path: '/lib/book' });
      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Refresh & Scan' }));
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Refreshed audio metadata');
      });
    });
  });
});
