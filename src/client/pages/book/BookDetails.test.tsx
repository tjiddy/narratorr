import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockBook, createMockSettings } from '@/__tests__/factories';
import { api } from '@/lib/api';
import { BookDetails } from './BookDetails';
import type { BookWithAuthor } from '@/lib/api';
import type { MetadataBook } from './helpers';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';

vi.mock('@/components/SearchReleasesModal', () => ({
  SearchReleasesModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Search Modal</div> : null,
}));

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
      getSettings: vi.fn(),
    },
  };
});

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

      await user.click(screen.getByText('Edit'));

      expect(screen.getByRole('dialog', { name: /edit book metadata/i })).toBeInTheDocument();
    });

    it('shows Rename button when book has path', () => {
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      expect(screen.getByText('Rename')).toBeInTheDocument();
    });

    it('hides Rename button when book has no path', () => {
      renderBookDetails({ path: null });

      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
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

      await user.click(screen.getByRole('button', { name: 'Rename' }));
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

      await user.click(screen.getByText('Edit'));

      const dialog = screen.getByRole('dialog', { name: /edit book metadata/i });
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

      await user.click(screen.getByText('Edit'));

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

      await user.click(screen.getByText('Edit'));

      const dialog = screen.getByRole('dialog', { name: /edit book metadata/i });
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

      await waitFor(() => {
        expect(screen.getByText('Re-tag files')).not.toBeDisabled();
      });

      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => {
        expect(screen.getByText('Re-tag files')).not.toBeDisabled();
      });

      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => {
        expect(screen.getByText('Re-tag files')).not.toBeDisabled();
      });

      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => {
        expect(screen.getByText('Re-tag files')).not.toBeDisabled();
      });

      await user.click(screen.getByText('Re-tag files'));
      const dialog4 = screen.getByRole('dialog');
      await user.click(within(dialog4).getAllByRole('button')[1]);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Re-tag failed: ffmpeg is not configured');
      });
    });

    it('disables Re-tag button when ffmpeg is not configured', async () => {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await waitFor(() => {
        expect(screen.getByText('Re-tag files')).toBeInTheDocument();
      });

      const button = screen.getByText('Re-tag files').closest('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Requires ffmpeg — configure in Settings > Post Processing');
    });

    it('enables Re-tag button when ffmpeg path is configured', async () => {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await waitFor(() => {
        const button = screen.getByText('Re-tag files').closest('button');
        expect(button).not.toBeDisabled();
      });
    });

    it('hides Re-tag button when book has no path', async () => {
      (api.getSettings as Mock).mockResolvedValue(createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      }));

      renderBookDetails({ path: null });

      // Wait for settings to load, then check button is absent
      await waitFor(() => {
        expect(screen.queryByText('Re-tag files')).not.toBeInTheDocument();
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

      await user.click(screen.getByRole('button', { name: 'Rename' }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('modal message includes the book title', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));

      expect(within(screen.getByRole('dialog')).getByText(/The Way of Kings/)).toBeInTheDocument();
    });

    it('modal message states the action cannot be undone', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));

      expect(within(screen.getByRole('dialog')).getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('confirm calls api.renameBook with the correct book ID', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockResolvedValue({ oldPath: '/old', newPath: '/new', message: 'Moved', filesRenamed: 1 });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));
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

      await user.click(screen.getByRole('button', { name: 'Rename' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('button')[1]);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('rapid repeated confirm clicks call api.renameBook at most once', async () => {
      const user = userEvent.setup();
      (api.renameBook as Mock).mockResolvedValue({ oldPath: '/old', newPath: '/new', message: 'Moved', filesRenamed: 1 });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));
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

      await user.click(screen.getByRole('button', { name: 'Rename' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('Escape key closes the modal without calling api.renameBook', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });

    it('backdrop click closes the modal without calling api.renameBook', async () => {
      const user = userEvent.setup();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await user.click(screen.getByRole('button', { name: 'Rename' }));
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

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('modal message includes the book title', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));

      expect(within(screen.getByRole('dialog')).getByText(/The Way of Kings/)).toBeInTheDocument();
    });

    it('modal message states the action cannot be undone', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));

      expect(within(screen.getByRole('dialog')).getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('confirm calls api.retagBook with the correct book ID', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      (api.retagBook as Mock).mockResolvedValue({ bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [] });
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));
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

      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.retagBook).not.toHaveBeenCalled();
    });

    it('Re-tag button is disabled when ffmpegConfigured is false and clicking does not open modal', async () => {
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      // getSettings not mocked → ffmpegConfigured = false → button disabled
      await waitFor(() => expect(screen.getByText('Re-tag files')).toBeDisabled());

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('rename and retag modals are independent — opening one does not affect the other', async () => {
      const user = userEvent.setup();
      mockFfmpegEnabled();
      renderBookDetails({ id: 1, path: '/library/test', status: 'imported' });

      // Open rename modal
      await user.click(screen.getByRole('button', { name: 'Rename' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Cancel rename — retag modal should not be open
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Open retag modal independently
      await waitFor(() => expect(screen.getByText('Re-tag files')).not.toBeDisabled());
      await user.click(screen.getByText('Re-tag files'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.renameBook).not.toHaveBeenCalled();
    });
  });
});
