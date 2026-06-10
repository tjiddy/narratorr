import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SuggestionRow } from '@/lib/api';
import { renderWithProviders } from '@/__tests__/helpers';
import { SuggestionCard } from './SuggestionCard';

function makeSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: 1,
    asin: 'B001',
    title: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    authorAsin: 'A_SANDERSON',
    narratorName: 'Michael Kramer',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 270, // 270 minutes = 4h 30m (Audible runtime_length_min)
    publishedDate: '2010-08-31',
    language: 'English',
    genres: ['Fantasy', 'Epic'],
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
    reason: 'author',
    reasonContext: 'Because you like Brandon Sanderson',
    score: 85,
    status: 'pending',
    refreshedAt: '2026-01-01T00:00:00Z',
    dismissedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    libraryBookId: null,
    ...overrides,
  };
}

const defaultProps = {
  index: 0,
  onAdd: vi.fn(),
  onDismiss: vi.fn(),
  isAdding: false,
  isDismissing: false,
};

describe('SuggestionCard', () => {
  describe('rendering', () => {
    it('renders title, authorName, narratorName, duration, reason tag with reasonContext', () => {
      renderWithProviders(<SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />);

      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
      expect(screen.getByText(/narrated by michael kramer/i)).toBeInTheDocument();
      expect(screen.getByText('4h 30m')).toBeInTheDocument();
      expect(screen.getByText('Because you like Brandon Sanderson')).toBeInTheDocument();
    });

    it('renders series tag from seriesName + seriesPosition when seriesName is present', () => {
      renderWithProviders(<SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />);
      expect(screen.getByText('The Stormlight Archive, Book 1')).toBeInTheDocument();
    });

    it('hides series tag when seriesName is null', () => {
      renderWithProviders(
        <SuggestionCard
          suggestion={makeSuggestion({ seriesName: null, seriesPosition: null })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/stormlight/i)).not.toBeInTheDocument();
    });

    it('hides duration badge when duration is null', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ duration: null })} {...defaultProps} />,
      );
      expect(screen.queryByText('4h 30m')).not.toBeInTheDocument();
    });

    it('hides duration badge when duration is 0', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ duration: 0 })} {...defaultProps} />,
      );
      expect(screen.queryByText('4h 30m')).not.toBeInTheDocument();
    });

    it('shows fallback icon when coverUrl is missing', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ coverUrl: null })} {...defaultProps} />,
      );
      // CoverImage renders fallback div when src is null
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('omits narrator line when narratorName is null', () => {
      renderWithProviders(
        <SuggestionCard
          suggestion={makeSuggestion({ narratorName: null })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/narrated by/i)).not.toBeInTheDocument();
    });

    it('renders card without reason tag when reasonContext is empty string', () => {
      renderWithProviders(
        <SuggestionCard
          suggestion={makeSuggestion({ reasonContext: '' })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/because you like/i)).not.toBeInTheDocument();
    });
  });

  describe('add to library', () => {
    it('calls onAdd with correct suggestion ID and overrides on confirm', async () => {
      const onAdd = vi.fn();
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ id: 42 })} {...defaultProps} onAdd={onAdd} />,
      );

      // Click Add to open popover, then confirm via "Add to Library"
      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));
      expect(onAdd).toHaveBeenCalledWith(42, expect.objectContaining({
        searchImmediately: expect.any(Boolean),
      }));
    });

    it('disables dismiss button when isAdding is true', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} isAdding={true} />,
      );

      expect(screen.getByLabelText(/dismiss/i)).toBeDisabled();
    });
  });

  describe('dismiss', () => {
    it('calls onDismiss with correct suggestion ID on click', async () => {
      const onDismiss = vi.fn();
      renderWithProviders(
        <SuggestionCard
          suggestion={makeSuggestion({ id: 7 })}
          {...defaultProps}
          onDismiss={onDismiss}
        />,
      );

      await userEvent.click(screen.getByLabelText(/dismiss/i));
      expect(onDismiss).toHaveBeenCalledWith(7);
    });
  });

  // --- #501: AddBookPopover integration and post-add states ---

  describe('AddBookPopover integration', () => {
    it('renders AddBookPopover trigger button with Add text', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />,
      );
      // AddBookPopover renders a button with "Add" text
      expect(screen.getByRole('button', { name: /^add book$/i })).toBeInTheDocument();
    });
  });

  describe('post-add states', () => {
    it('shows Add button and Dismiss button in available state', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} isAdded={false} />,
      );
      expect(screen.getByRole('button', { name: /^add book$/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/dismiss/i)).toBeInTheDocument();
    });

    it('shows In Library badge and no Add button in added state', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} isAdded={true} />,
      );
      expect(screen.getByLabelText(/in library/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^add book$/i })).not.toBeInTheDocument();
    });

    it('shows Dismiss button in added state', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} isAdded={true} />,
      );
      expect(screen.getByLabelText(/dismiss/i)).toBeInTheDocument();
    });
  });

  describe('libraryBookId standardized In Library badge', () => {
    it('renders a link to /books/<id> when suggestion.libraryBookId is set', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ libraryBookId: 42 })} {...defaultProps} />,
      );
      const link = screen.getByRole('link', { name: /view this book in your library/i });
      expect(link).toHaveAttribute('href', '/books/42');
      expect(screen.getByText('In Library')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^add book$/i })).not.toBeInTheDocument();
    });

    it('renders AddBookPopover and no /books link when libraryBookId is null', () => {
      renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion({ libraryBookId: null })} {...defaultProps} />,
      );
      expect(screen.getByRole('button', { name: /^add book$/i })).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('uses the addedLibraryBookId transient when suggestion.libraryBookId is null', () => {
      renderWithProviders(
        <SuggestionCard
          suggestion={makeSuggestion({ libraryBookId: null })}
          {...defaultProps}
          isAdded={true}
          addedLibraryBookId={99}
        />,
      );
      const link = screen.getByRole('link', { name: /view this book in your library/i });
      expect(link).toHaveAttribute('href', '/books/99');
    });
  });

  describe('cover aspect ratio', () => {
    it('renders cover image with square dimensions', () => {
      const { container } = renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />,
      );
      const coverContainer = container.querySelector('.shrink-0');
      // Should have square classes (w-20 h-20), not rectangular (w-20 h-28)
      const coverEl = coverContainer?.firstElementChild;
      expect(coverEl?.className).toMatch(/w-20/);
      expect(coverEl?.className).toMatch(/h-20/);
      expect(coverEl?.className).not.toMatch(/h-28/);
    });
  });

  describe('animation', () => {
    it('stagger animation index capped at 9', () => {
      const { container } = renderWithProviders(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} index={15} />,
      );

      const card = container.firstElementChild as HTMLElement;
      expect(card.style.animationDelay).toBe('450ms'); // Math.min(15, 9) * 50 = 450
    });
  });

  // --- #524: SuggestionCard authorAsin in fixture ---
  describe('authorAsin wire contract', () => {
    it('includes authorAsin in makeSuggestion fixture', () => {
      const suggestion = makeSuggestion();
      expect(suggestion.authorAsin).toBe('A_SANDERSON');
    });

    it('defaults authorAsin to null when not provided', () => {
      const suggestion = makeSuggestion({ authorAsin: null });
      expect(suggestion.authorAsin).toBeNull();
    });
  });
});
