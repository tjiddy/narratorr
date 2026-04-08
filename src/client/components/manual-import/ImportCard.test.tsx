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
    isDuplicate: false,
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

    it('renders pending badge with muted variant (ring-border/20) and spinner icon', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: undefined })} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-muted/50', 'ring-1', 'ring-border/20');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    });

    it('shows green "Matched" badge for high confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'high' }) })} />);
      expect(screen.getByText('Matched')).toBeInTheDocument();
    });

    it('renders high confidence badge with success (emerald) variant and leading icon', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'high' }) })} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-emerald-500/15', 'text-emerald-400', 'ring-1', 'ring-emerald-500/20');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    });

    it('shows yellow "Review" badge for medium confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'medium' }) })} />);
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    it('renders medium confidence badge with warning (amber) variant and leading icon', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'medium' }) })} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-amber-500/15', 'text-amber-400', 'ring-1', 'ring-amber-500/20');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    });

    it('shows red "No Match" badge for none confidence', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }) })} />);
      expect(screen.getByText('No Match')).toBeInTheDocument();
    });

    it('renders none confidence badge with danger (red) variant and leading icon', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }) })} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-red-500/15', 'text-red-400', 'ring-1', 'ring-red-500/20');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
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

    it('shows singular "1 file" form when fileCount is 1', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ book: makeBook({ fileCount: 1 }) })} />);
      expect(screen.getByText(/1 file[^s]/)).toBeInTheDocument();
      expect(screen.queryByText(/1 files/)).not.toBeInTheDocument();
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

  // ===========================================================================
  // #114 — duplicate row rendering
  // ===========================================================================
  describe('duplicate rows (isDuplicate: true)', () => {
    const dupRow = makeRow({
      book: makeBook({ isDuplicate: true, existingBookId: 42 }),
      selected: false,
    });

    it('shows "Already in library" badge when book.isDuplicate is true', () => {
      render(<ImportCard {...defaultProps} row={dupRow} />);
      expect(screen.getByText('Already in library')).toBeInTheDocument();
    });

    it('renders "Already in library" badge with muted variant and no icon', () => {
      render(<ImportCard {...defaultProps} row={dupRow} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-muted/50', 'ring-1', 'ring-border/20');
      expect(badge.querySelector('svg')).not.toBeInTheDocument();
    });

    it('does not show confidence badge for duplicate rows', () => {
      render(<ImportCard {...defaultProps} row={dupRow} />);
      expect(screen.queryByText('Matching')).not.toBeInTheDocument();
      expect(screen.queryByText('Matched')).not.toBeInTheDocument();
    });

    it('unselected duplicate row renders visually muted (opacity-60)', () => {
      const { container } = render(<ImportCard {...defaultProps} row={dupRow} />);
      const rowEl = container.firstChild as HTMLElement;
      expect(rowEl.className).toContain('opacity-60');
    });

    it('selected duplicate row is not dimmed (neither opacity-60 nor opacity-50)', () => {
      const selectedDupRow = makeRow({
        book: makeBook({ isDuplicate: true, existingBookId: 42 }),
        selected: true,
        // no matchResult → confidence is undefined, as in Manual Import force-import path
      });
      const { container } = render(<ImportCard {...defaultProps} row={selectedDupRow} />);
      const rowEl = container.firstChild as HTMLElement;
      expect(rowEl.className).not.toContain('opacity-60');
      expect(rowEl.className).not.toContain('opacity-50');
    });

    it('duplicate row checkbox is enabled and calls onToggle when clicked', async () => {
      const onToggle = vi.fn();
      render(<ImportCard {...defaultProps} row={dupRow} onToggle={onToggle} />);
      await userEvent.click(screen.getByRole('button', { name: /Select/i }));
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('edit button is not visible for duplicate rows', () => {
      render(<ImportCard {...defaultProps} row={dupRow} />);
      expect(screen.queryByRole('button', { name: /Edit metadata/i })).not.toBeInTheDocument();
    });

    it('non-duplicate rows are unaffected by isDuplicate: false', () => {
      const normalRow = makeRow({ book: makeBook({ isDuplicate: false }) });
      render(<ImportCard {...defaultProps} row={normalRow} />);
      expect(screen.queryByText('Already in library')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Edit metadata/i })).toBeInTheDocument();
    });
  });
});

describe('ImportCard — lockDuplicates prop (#133)', () => {
  it('lockDuplicates=false (default): duplicate row renders checkbox (existing Manual Import behavior)', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'path' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /deselect/i })).toBeInTheDocument();
  });

  it('lockDuplicates=true + path-duplicate (duplicateReason=path): no checkbox, no edit button, Already in library badge', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'path' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByText('Already in library')).toBeInTheDocument();
  });

  it('lockDuplicates=true + slug-duplicate (duplicateReason=slug): no checkbox, edit button shown, Already in library badge', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'slug' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByText('Already in library')).toBeInTheDocument();
  });

  it('lockDuplicates=true + non-duplicate: normal card with checkbox and edit button', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: false }), matchResult: makeMatchResult() });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.getByRole('button', { name: /deselect/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });
});

describe('ImportCard — relativePath prop (#133)', () => {
  it('renders relative path when relativePath prop provided', () => {
    const row = makeRow({ book: makeBook({ path: '/media/audiobooks/Author/Book' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} relativePath="Author/Book" />);
    expect(screen.getByText('Author/Book')).toBeInTheDocument();
  });

  it('falls back to existing short-path display when relativePath absent', () => {
    const row = makeRow({ book: makeBook({ path: '/media/audiobooks/Author/Book' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
    // Should show last 3 path segments (short path fallback)
    expect(screen.getByText('audiobooks/Author/Book')).toBeInTheDocument();
  });

  describe('within-scan duplicates (#342)', () => {
    it('within-scan duplicate shows Duplicate in scan badge instead of Already in library', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: true, duplicateReason: 'within-scan' as 'path' | 'slug' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.getByText('Duplicate in scan')).toBeInTheDocument();
      expect(screen.queryByText('Already in library')).not.toBeInTheDocument();
    });

    it('within-scan duplicate has checkbox shown (selectable) when lockDuplicates is true', () => {
      const onToggle = vi.fn();
      const row = makeRow({
        book: makeBook({ isDuplicate: true, duplicateReason: 'within-scan' as 'path' | 'slug' }),
      });
      render(<ImportCard row={row} onToggle={onToggle} onEdit={vi.fn()} lockDuplicates />);
      const selectBtn = screen.getByRole('button', { name: /select|deselect/i });
      expect(selectBtn).toBeInTheDocument();
    });

    it('within-scan duplicate has edit button shown when lockDuplicates is true', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: true, duplicateReason: 'within-scan' as 'path' | 'slug' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    it('DB path duplicate still has no checkbox when lockDuplicates is true', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: true, duplicateReason: 'path' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    });

    it('DB slug duplicate still has no checkbox when lockDuplicates is true', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: true, duplicateReason: 'slug' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    });
  });

  // ── #415 Match confidence reason on badge ───────────────────────────
  describe('confidence reason display (#415)', () => {
    it.todo('medium confidence with reason string → reason text visible via tooltip or subtitle');
    it.todo('medium confidence without reason (null/undefined) → badge renders normally without empty tooltip');
    it.todo('high confidence with reason left over → no reason text rendered');
    it.todo('none confidence → no reason text rendered');
  });
});
