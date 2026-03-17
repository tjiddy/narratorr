import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SuggestionRow } from '@/lib/api';
import { SuggestionCard } from './SuggestionCard';

function makeSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: 1,
    asin: 'B001',
    title: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    narratorName: 'Michael Kramer',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 16200, // 270 minutes = 4h 30m
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
      render(<SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />);

      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
      expect(screen.getByText(/narrated by michael kramer/i)).toBeInTheDocument();
      expect(screen.getByText('4h 30m')).toBeInTheDocument();
      expect(screen.getByText('Because you like Brandon Sanderson')).toBeInTheDocument();
    });

    it('renders series tag from seriesName + seriesPosition when seriesName is present', () => {
      render(<SuggestionCard suggestion={makeSuggestion()} {...defaultProps} />);
      expect(screen.getByText('The Stormlight Archive, Book 1')).toBeInTheDocument();
    });

    it('hides series tag when seriesName is null', () => {
      render(
        <SuggestionCard
          suggestion={makeSuggestion({ seriesName: null, seriesPosition: null })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/stormlight/i)).not.toBeInTheDocument();
    });

    it('hides duration badge when duration is null', () => {
      render(
        <SuggestionCard suggestion={makeSuggestion({ duration: null })} {...defaultProps} />,
      );
      expect(screen.queryByText('4h 30m')).not.toBeInTheDocument();
    });

    it('hides duration badge when duration is 0', () => {
      render(
        <SuggestionCard suggestion={makeSuggestion({ duration: 0 })} {...defaultProps} />,
      );
      expect(screen.queryByText('4h 30m')).not.toBeInTheDocument();
    });

    it('shows fallback icon when coverUrl is missing', () => {
      render(
        <SuggestionCard suggestion={makeSuggestion({ coverUrl: null })} {...defaultProps} />,
      );
      // CoverImage renders fallback div when src is null
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('omits narrator line when narratorName is null', () => {
      render(
        <SuggestionCard
          suggestion={makeSuggestion({ narratorName: null })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/narrated by/i)).not.toBeInTheDocument();
    });

    it('renders card without reason tag when reasonContext is empty string', () => {
      render(
        <SuggestionCard
          suggestion={makeSuggestion({ reasonContext: '' })}
          {...defaultProps}
        />,
      );
      expect(screen.queryByText(/because you like/i)).not.toBeInTheDocument();
    });
  });

  describe('add to library', () => {
    it('calls onAdd with correct suggestion ID on click', async () => {
      const onAdd = vi.fn();
      render(
        <SuggestionCard suggestion={makeSuggestion({ id: 42 })} {...defaultProps} onAdd={onAdd} />,
      );

      await userEvent.click(screen.getByLabelText(/add.*to library/i));
      expect(onAdd).toHaveBeenCalledWith(42);
    });

    it('disables buttons when isAdding is true', () => {
      render(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} isAdding={true} />,
      );

      expect(screen.getByLabelText(/add.*to library/i)).toBeDisabled();
      expect(screen.getByLabelText(/dismiss/i)).toBeDisabled();
    });
  });

  describe('dismiss', () => {
    it('calls onDismiss with correct suggestion ID on click', async () => {
      const onDismiss = vi.fn();
      render(
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

  describe('animation', () => {
    it('stagger animation index capped at 9', () => {
      const { container } = render(
        <SuggestionCard suggestion={makeSuggestion()} {...defaultProps} index={15} />,
      );

      const card = container.firstElementChild as HTMLElement;
      expect(card.style.animationDelay).toBe('450ms'); // Math.min(15, 9) * 50 = 450
    });
  });
});
