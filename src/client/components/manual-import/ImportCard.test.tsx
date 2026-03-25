import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCard, type ImportRow } from './ImportCard';
import type { MatchResult } from '@/lib/api';

function makeBook(overrides?: Partial<ImportRow['book']>): ImportRow['book'] {
  return {
    path: '/media/audiobooks/Author Name/Series Name/Book Title',
    parsedTitle: 'Book Title',
    parsedAuthor: 'Author Name',
    parsedSeries: 'Series Name',
    fileCount: 12,
    totalSize: 524288000,
    ...overrides,
  };
}

function makeRow(overrides?: Partial<ImportRow>): ImportRow {
  return {
    book: makeBook(),
    selected: true,
    edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name' },
    ...overrides,
  };
}

function makeMatchResult(overrides?: Partial<MatchResult>): MatchResult {
  return {
    path: '/media/audiobooks/Author Name/Series Name/Book Title',
    confidence: 'high',
    bestMatch: {
      title: 'Book Title',
      authors: [{ name: 'Author Name' }],
      narrators: ['Jim Dale'],
      asin: 'B001',
    },
    alternatives: [],
    ...overrides,
  };
}

describe('ImportCard', () => {
  const defaultProps = {
    row: makeRow(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
  };

  describe('confidence badges', () => {
    it('shows "Matching" badge when no match result exists (pending)', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: undefined })} />);
      expect(screen.getByText('Matching')).toBeInTheDocument();
    });

    it('shows green "Matched" badge for high confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'high' }) })} />);
      expect(screen.getByText('Matched')).toBeInTheDocument();
    });

    it('shows yellow "Review" badge for medium confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'medium' }) })} />);
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    it('shows red "No Match" badge for none confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }) })} />);
      expect(screen.getByText('No Match')).toBeInTheDocument();
    });
  });

  describe('path display', () => {
    it('shows last 3 path segments', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ book: makeBook({ path: '/media/audiobooks/Author/Series/Book' }) })} />);
      expect(screen.getByText('Author/Series/Book')).toBeInTheDocument();
    });

    it('handles short paths with fewer than 3 segments', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ book: makeBook({ path: '/Book' }) })} />);
      expect(screen.getByText('Book')).toBeInTheDocument();
    });

    it('sets full path as title attribute for tooltip', () => {
      const fullPath = '/media/audiobooks/Author/Series/Book';
      render(<ImportCard {...defaultProps} row={makeRow({ book: makeBook({ path: fullPath }) })} />);
      expect(screen.getByTitle(fullPath)).toBeInTheDocument();
    });
  });

  describe('narrator display', () => {
    it('shows narrator from edited.metadata.narrators when present', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Jim Dale'] } },
        })}
      />);
      expect(screen.getByText(/Jim Dale/)).toBeInTheDocument();
    });

    it('shows updated narrator from edited.metadata, not stale matchResult.bestMatch.narrators', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult({ bestMatch: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Stephen Fry'] } }),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Jim Dale'] } },
        })}
      />);
      expect(screen.getByText(/Jim Dale/)).toBeInTheDocument();
      expect(screen.queryByText(/Stephen Fry/)).not.toBeInTheDocument();
    });

    it('shows file count when edited.metadata is absent (no match yet)', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: undefined, edited: { title: 'Book Title', author: 'Author Name', series: '' } })} />);
      expect(screen.getByText(/12 files/)).toBeInTheDocument();
    });

    it('shows file count when edited.metadata.narrators is an empty array', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: '', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: [] } },
        })}
      />);
      expect(screen.getByText(/12 files/)).toBeInTheDocument();
    });

    it('shows file size', () => {
      render(<ImportCard {...defaultProps} row={makeRow()} />);
      expect(screen.getByText(/500/)).toBeInTheDocument(); // 524288000 bytes ~ 500 MB
    });
  });

  describe('checkbox interaction', () => {
    it('calls onToggle when checkbox clicked', async () => {
      const onToggle = vi.fn();
      render(<ImportCard {...defaultProps} onToggle={onToggle} />);

      await userEvent.click(screen.getByLabelText('Deselect'));
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('shows "Deselect" label when selected', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ selected: true })} />);
      expect(screen.getByLabelText('Deselect')).toBeInTheDocument();
    });

    it('shows "Select" label when not selected', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ selected: false })} />);
      expect(screen.getByLabelText('Select')).toBeInTheDocument();
    });
  });

  describe('edit button', () => {
    it('calls onEdit when pencil clicked', async () => {
      const onEdit = vi.fn();
      render(<ImportCard {...defaultProps} onEdit={onEdit} row={makeRow({ matchResult: makeMatchResult({ confidence: 'medium' }) })} />);

      await userEvent.click(screen.getByLabelText('Edit metadata'));
      expect(onEdit).toHaveBeenCalledOnce();
    });
  });

  describe('visual states', () => {
    it('dims pending rows (opacity-50)', () => {
      const { container } = render(<ImportCard {...defaultProps} row={makeRow({ matchResult: undefined })} />);
      expect(container.firstChild).toHaveClass('opacity-50');
    });

    it('does not dim matched rows', () => {
      const { container } = render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult() })} />);
      expect(container.firstChild).not.toHaveClass('opacity-50');
    });

    it('shows amber left border for no-match rows', () => {
      const { container } = render(
        <ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }) })} />,
      );
      expect(container.firstChild).toHaveClass('border-l-amber-500');
    });
  });

  describe('display values', () => {
    it('uses edited title over parsed title', () => {
      render(
        <ImportCard
          {...defaultProps}
          row={makeRow({
            book: makeBook({ parsedTitle: 'Parsed Title' }),
            edited: { title: 'Edited Title', author: '', series: '' },
          })}
        />,
      );
      expect(screen.getByText('Edited Title')).toBeInTheDocument();
    });

    it('falls back to parsed author when edited author is empty', () => {
      render(
        <ImportCard
          {...defaultProps}
          row={makeRow({
            book: makeBook({ parsedAuthor: 'Parsed Author' }),
            edited: { title: 'Title', author: '', series: '' },
          })}
        />,
      );
      expect(screen.getByText('Parsed Author')).toBeInTheDocument();
    });

    it('shows "Unknown" when no author available', () => {
      render(
        <ImportCard
          {...defaultProps}
          row={makeRow({
            book: makeBook({ parsedAuthor: null }),
            edited: { title: 'Title', author: '', series: '' },
          })}
        />,
      );
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });
});
