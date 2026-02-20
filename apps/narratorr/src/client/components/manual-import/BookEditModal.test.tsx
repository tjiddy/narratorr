import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookEditModal, type BookEditState } from './BookEditModal';
import type { DiscoveredBook, BookMetadata } from '@/lib/api';

// Mock the useLibrary hook
vi.mock('@/hooks/useLibrary', () => ({
  useLibrary: () => ({ data: [] }),
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

  describe('field editing', () => {
    it('allows editing title', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Book Title');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Title');
      expect(input).toHaveValue('New Title');
    });

    it('allows editing author', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Author Name');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Author');
      expect(input).toHaveValue('New Author');
    });

    it('allows editing series', async () => {
      renderModal();
      const input = screen.getByDisplayValue('Series Name');
      await userEvent.clear(input);
      await userEvent.type(input, 'New Series');
      expect(input).toHaveValue('New Series');
    });
  });

  describe('save behavior', () => {
    it('calls onSave with current field values', async () => {
      const onSave = vi.fn();
      renderModal({ onSave });

      await userEvent.click(screen.getByText('Save'));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Book Title',
        author: 'Author Name',
        series: 'Series Name',
      }));
    });

    it('trims whitespace from fields on save', async () => {
      const onSave = vi.fn();
      renderModal({ onSave, initial: makeEditState({ title: '  Padded Title  ' }) });

      await userEvent.click(screen.getByText('Save'));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Padded Title',
      }));
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
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        metadata: meta,
        asin: 'B001',
        coverUrl: 'https://example.com/cover.jpg',
      }));
    });
  });

  describe('close behavior', () => {
    it('calls onClose when Cancel clicked', async () => {
      const onClose = vi.fn();
      renderModal({ onClose });

      await userEvent.click(screen.getByText('Cancel'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when backdrop clicked', async () => {
      const onClose = vi.fn();
      renderModal({ onClose });

      // The backdrop is the first child with bg-black/60
      const backdrop = document.querySelector('.bg-black\\/60');
      if (backdrop) await userEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledOnce();
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
      expect(screen.getByDisplayValue('Test')).toBeInTheDocument();
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
      expect(screen.getByDisplayValue('Alt Book')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Alt Author')).toBeInTheDocument();
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
      expect(screen.getByText('Result B')).toBeInTheDocument();
      expect(screen.getByText('Result C')).toBeInTheDocument();
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
});
