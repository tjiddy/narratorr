import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookEditModal, type BookEditState } from './BookEditModal';
import type { DiscoveredBook, BookMetadata } from '@/lib/api';

// Mock the useLibrary hook — default to empty, tests can override via mockIdentifiers
let mockIdentifiers: { asin: string | null; title: string; authorName: string | null }[] = [];
vi.mock('@/hooks/useLibrary', () => ({
  useBookIdentifiers: () => ({ data: mockIdentifiers }),
}));

// Mock the useEscapeKey hook
vi.mock('@/hooks/useEscapeKey', () => ({
  useEscapeKey: vi.fn(),
}));

// Mock the API
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      searchMetadata: vi.fn(),
    },
    formatBytes: (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`,
  };
});

function makeBook(overrides?: Partial<DiscoveredBook>): DiscoveredBook {
  return {
    path: '/media/audiobooks/Author/Series/Book Title',
    parsedTitle: 'Book Title',
    parsedAuthor: 'Author Name',
    parsedSeries: 'Series Name',
    fileCount: 12,
    totalSize: 524288000,
    isDuplicate: false,
    ...overrides,
  };
}

function makeMetadata(overrides?: Partial<BookMetadata>): BookMetadata {
  return {
    title: 'Matched Title',
    authors: [{ name: 'Matched Author' }],
    narrators: ['Jim Dale'],
    asin: 'B001',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 600,
    ...overrides,
  };
}

function makeEditState(overrides?: Partial<BookEditState>): BookEditState {
  return {
    title: 'Book Title',
    author: 'Author Name',
    series: 'Series Name',
    ...overrides,
  };
}

function renderModal(overrides?: Record<string, unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaults = {
    book: makeBook(),
    initial: makeEditState(),
    onSave: vi.fn(),
    onClose: vi.fn(),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <BookEditModal {...defaults} {...overrides} />
    </QueryClientProvider>,
  );
}

describe('BookEditModal', () => {
  describe('source path display', () => {
    it('shows the book path in the header', () => {
      renderModal({ book: makeBook({ path: '/media/audio/Author/Book' }) });
      expect(screen.getByText('/media/audio/Author/Book')).toBeInTheDocument();
    });
  });

  describe('initial state rendering', () => {
    it('populates fields from initial edit state', () => {
      renderModal({ initial: makeEditState({ title: 'My Title', author: 'My Author', series: 'My Series' }) });
      expect(screen.getByDisplayValue('My Title')).toBeInTheDocument();
      expect(screen.getByDisplayValue('My Author')).toBeInTheDocument();
      expect(screen.getByDisplayValue('My Series')).toBeInTheDocument();
    });

    it('shows metadata preview when initial has metadata', () => {
      const meta = makeMetadata();
      renderModal({ initial: makeEditState({ metadata: meta }) });
      // Title appears in both the preview header and the alternatives list
      expect(screen.getAllByText('Matched Title').length).toBeGreaterThanOrEqual(1);
    });

    it('shows "No metadata match" message when no metadata', () => {
      renderModal({ initial: makeEditState({ metadata: undefined }), confidence: 'none' });
      expect(screen.getByText(/No metadata match/)).toBeInTheDocument();
    });

    it('shows file info (count and size)', () => {
      renderModal({ book: makeBook({ fileCount: 37, totalSize: 1200000000 }) });
      expect(screen.getByText(/37 files/)).toBeInTheDocument();
    });
  });

  describe('URL_BASE resolveUrl integration', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prefixes app-relative metadata preview cover URL with URL_BASE via resolveUrl', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveUrl').mockImplementation(
        (url) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          return `/narratorr${url}`;
        },
      );

      const meta = makeMetadata({ coverUrl: '/api/books/1/cover' });
      renderModal({ initial: makeEditState({ metadata: meta }) });

      const imgs = document.querySelectorAll('img');
      const coverImg = Array.from(imgs).find(img => img.getAttribute('src')?.includes('/api/books/1/cover'));
      expect(coverImg).toBeTruthy();
      expect(coverImg!.getAttribute('src')).toBe('/narratorr/api/books/1/cover');
    });

    it('prefixes app-relative alternative match cover URLs with URL_BASE via resolveUrl', async () => {
      vi.spyOn(await import('@/lib/url-utils'), 'resolveUrl').mockImplementation(
        (url) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          return `/narratorr${url}`;
        },
      );

      const bestMatch = makeMetadata({ providerId: 'best', coverUrl: 'https://example.com/cover.jpg' });
      const alt = makeMetadata({ title: 'Alt Book', providerId: 'alt1', coverUrl: '/api/books/2/cover' });
      renderModal({
        initial: makeEditState({ metadata: bestMatch }),
        alternatives: [alt],
        confidence: 'medium',
      });

      const imgs = document.querySelectorAll('img');
      const altCoverImg = Array.from(imgs).find(img => img.getAttribute('src') === '/narratorr/api/books/2/cover');
      expect(altCoverImg).toBeTruthy();
    });
  });

  describe('field editing', () => {
    it('allows editing title', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Book Title');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Title');
      await waitFor(() => {
        expect(input).toHaveValue('New Title');
      });
    });

    it('allows editing author', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Author Name');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Author');
      await waitFor(() => {
        expect(input).toHaveValue('New Author');
      });
    });

    it('allows editing series', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Series Name');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Series');
      await waitFor(() => {
        expect(input).toHaveValue('New Series');
      });
    });
  });

  describe('save behavior', () => {
    it('calls onSave with current field values', async () => {
      const onSave = vi.fn();
      renderModal({ onSave });

      await userEvent.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Book Title',
          author: 'Author Name',
          series: 'Series Name',
        }));
      });
    });

    it('trims whitespace from fields on save', async () => {
      const onSave = vi.fn();
      renderModal({ onSave, initial: makeEditState({ title: '  Padded Title  ' }) });

      await userEvent.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Padded Title',
        }));
      });
    });

    it('disables Save when title is empty', async () => {
      renderModal({ initial: makeEditState({ title: '' }) });
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('includes metadata in save when a match is selected', async () => {
      const meta = makeMetadata();
      const onSave = vi.fn();
      renderModal({ onSave, initial: makeEditState({ metadata: meta }) });

      await userEvent.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
          metadata: meta,
          asin: 'B001',
          coverUrl: 'https://example.com/cover.jpg',
        }));
      });
    });
  });

  describe('close behavior', () => {
    it('calls onClose when Cancel clicked', async () => {
      const onClose = vi.fn();
      renderModal({ onClose });

      await userEvent.click(screen.getByText('Cancel'));
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledOnce();
      });
    });

    it('calls onClose when backdrop clicked', async () => {
      const onClose = vi.fn();
      renderModal({ onClose });

      const backdrop = screen.getByTestId('modal-backdrop');
      await userEvent.click(backdrop);
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledOnce();
      });
    });
  });

  describe('search providers', () => {
    it('disables search button when title and author are empty', () => {
      renderModal({ initial: makeEditState({ title: '', author: '' }) });
      expect(screen.getByText('Search Providers').closest('button')).toBeDisabled();
    });

    it('enables search button when title is present', () => {
      renderModal({ initial: makeEditState({ title: 'Something', author: '' }) });
      expect(screen.getByText('Search Providers').closest('button')).toBeEnabled();
    });

    it('does NOT auto-select first search result', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [makeMetadata({ title: 'Search Result 1' }), makeMetadata({ title: 'Search Result 2' })],
        authors: [],
        series: [],
      });

      renderModal({ initial: makeEditState({ title: 'Test', author: 'Author' }) });
      await userEvent.click(screen.getByText('Search Providers'));

      // Wait for results to render
      await screen.findByText('Search Result 1');

      // Title field should still have original value, NOT the search result
      await waitFor(() => {
        expect(screen.getByDisplayValue('Test')).toBeInTheDocument();
      });
    });

    it('shows "No results found" when search returns empty', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({ books: [], authors: [], series: [] });

      renderModal({ initial: makeEditState({ title: 'Obscure Book', author: '' }) });
      await userEvent.click(screen.getByText('Search Providers'));

      await screen.findByText(/No results found/);
    });

    it('highlights search button for no-match rows', () => {
      renderModal({ confidence: 'none', initial: makeEditState() });
      const btn = screen.getByText('Search Providers').closest('button');
      expect(btn?.className).toContain('bg-primary');
    });
  });

  describe('alternative matches', () => {
    it('shows alternatives from match result', () => {
      const alt1 = makeMetadata({ title: 'Alternative 1', providerId: 'alt1' });
      const alt2 = makeMetadata({ title: 'Alternative 2', providerId: 'alt2' });
      const bestMatch = makeMetadata({ title: 'Best Match', providerId: 'best' });

      renderModal({
        initial: makeEditState({ metadata: bestMatch }),
        alternatives: [alt1, alt2],
        confidence: 'medium',
      });

      expect(screen.getByText('Alternative 1')).toBeInTheDocument();
      expect(screen.getByText('Alternative 2')).toBeInTheDocument();
    });

    it('applies metadata when alternative is clicked', async () => {
      const alt = makeMetadata({ title: 'Alt Book', authors: [{ name: 'Alt Author' }], providerId: 'alt1' });
      const bestMatch = makeMetadata({ title: 'Best', providerId: 'best' });

      renderModal({
        initial: makeEditState({ metadata: bestMatch }),
        alternatives: [alt],
        confidence: 'medium',
      });

      await userEvent.click(screen.getByText('Alt Book'));

      // Fields should update to the alternative's values
      await waitFor(() => {
        expect(screen.getByDisplayValue('Alt Book')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Alt Author')).toBeInTheDocument();
      });
    });

    it('shows duration on alternatives when available', () => {
      const alt = makeMetadata({ title: 'Alt', providerId: 'alt1', duration: 692 });
      const bestMatch = makeMetadata({ title: 'Best', providerId: 'best' });

      renderModal({
        initial: makeEditState({ metadata: bestMatch }),
        alternatives: [alt],
      });

      expect(screen.getByText('11h 32m')).toBeInTheDocument();
    });

    it('shows all search results (does not skip first)', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      const results = [
        makeMetadata({ title: 'Result A', providerId: 'a' }),
        makeMetadata({ title: 'Result B', providerId: 'b' }),
        makeMetadata({ title: 'Result C', providerId: 'c' }),
      ];
      searchMock.mockResolvedValueOnce({ books: results, authors: [], series: [] });

      renderModal({ initial: makeEditState({ title: 'Test', author: '' }) });
      await userEvent.click(screen.getByText('Search Providers'));

      await screen.findByText('Result A');
      await waitFor(() => {
        expect(screen.getByText('Result B')).toBeInTheDocument();
        expect(screen.getByText('Result C')).toBeInTheDocument();
      });
    });

    it('shows only first 6 results when search returns 7 (slice boundary)', () => {
      const alts = Array.from({ length: 7 }, (_, i) =>
        makeMetadata({ title: `Result ${i + 1}`, providerId: `r${i + 1}` }),
      );
      renderModal({ alternatives: alts });

      expect(screen.getByText('Result 1')).toBeInTheDocument();
      expect(screen.getByText('Result 6')).toBeInTheDocument();
      expect(screen.queryByText('Result 7')).not.toBeInTheDocument();
    });

    it('shows all 6 results when search returns exactly 6 (no off-by-one drop)', () => {
      const alts = Array.from({ length: 6 }, (_, i) =>
        makeMetadata({ title: `Result ${i + 1}`, providerId: `r${i + 1}` }),
      );
      renderModal({ alternatives: alts });

      expect(screen.getByText('Result 1')).toBeInTheDocument();
      expect(screen.getByText('Result 6')).toBeInTheDocument();
    });

    it('applyMetadata with multiple authors sets first author only', async () => {
      const alt = makeMetadata({
        title: 'Multi Author Book',
        authors: [{ name: 'Author A' }, { name: 'Author B' }],
        providerId: 'multi',
      });
      renderModal({ alternatives: [alt] });

      await userEvent.click(screen.getByText('Multi Author Book'));

      await waitFor(() => {
        expect(screen.getByDisplayValue('Author A')).toBeInTheDocument();
      });
      expect(screen.queryByDisplayValue('Author B')).not.toBeInTheDocument();
    });

    it('shows narrator display for alternatives with multiple narrators joined by comma', () => {
      const alt = makeMetadata({
        title: 'Narrated Book',
        narrators: ['Jim Dale', 'Stephen Fry'],
        providerId: 'narr',
      });
      renderModal({ alternatives: [alt] });

      expect(screen.getByText('Jim Dale, Stephen Fry')).toBeInTheDocument();
    });

    it('shows section label based on confidence', () => {
      renderModal({
        confidence: 'medium',
        initial: makeEditState({ metadata: makeMetadata({ providerId: 'best' }) }),
        alternatives: [makeMetadata({ providerId: 'alt1' })],
      });
      expect(screen.getByText('Pick the correct match')).toBeInTheDocument();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe('duplicate detection via identifiers', () => {
    afterEach(() => {
      mockIdentifiers = [];
    });

    it('shows "In library" badge when metadata ASIN matches an identifier', () => {
      mockIdentifiers = [{ asin: 'B001', title: 'Matched Title', authorName: 'Matched Author' }];
      const meta = makeMetadata({ asin: 'B001' });
      renderModal({ initial: makeEditState({ metadata: meta }) });

      expect(screen.getByText('In library')).toBeInTheDocument();
    });

    it('renders "In library" badge with success (emerald) variant, leading icon, and shrink-0', () => {
      mockIdentifiers = [{ asin: 'B001', title: 'Matched Title', authorName: 'Matched Author' }];
      const meta = makeMetadata({ asin: 'B001' });
      renderModal({ initial: makeEditState({ metadata: meta }) });

      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-emerald-500/15', 'text-emerald-400', 'ring-1', 'ring-emerald-500/20', 'shrink-0');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    });

    it('does not show "In library" badge when no identifier matches', () => {
      mockIdentifiers = [{ asin: 'B999', title: 'Other Book', authorName: 'Other Author' }];
      const meta = makeMetadata({ asin: 'B001' });
      renderModal({ initial: makeEditState({ metadata: meta }) });

      expect(screen.queryByText('In library')).not.toBeInTheDocument();
    });
  });
});
