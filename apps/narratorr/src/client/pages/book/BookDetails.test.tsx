import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BookDetails } from './BookDetails';
import type { BookWithAuthor } from '@/lib/api';
import type { MetadataBook } from './helpers';

vi.mock('@/components/SearchReleasesModal', () => ({
  SearchReleasesModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Search Modal</div> : null,
}));

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'The Way of Kings',
    status: 'wanted',
    authorId: 1,
    narrator: 'Michael Kramer',
    description: '<p>An epic fantasy novel.</p>',
    coverUrl: 'https://example.com/cover.jpg',
    genres: ['Fantasy', 'Epic'],
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
    duration: 52320,
    audioCodec: 'AAC',
    audioBitrate: 128000,
    audioSampleRate: 44100,
    audioChannels: 2,
    audioBitrateMode: 'cbr',
    audioFileCount: 12,
    audioTotalSize: 500_000_000,
    audioDuration: 36000,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'A001' },
    ...overrides,
  };
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
        author: { id: 1, name: 'Unknown Author', slug: 'unknown-author', asin: null },
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
  });
});
