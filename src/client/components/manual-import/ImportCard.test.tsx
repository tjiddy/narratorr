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
    userEdited: false,
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
      render(<ImportCard {...defaultProps} row={makeRow()} />);
      expect(screen.getByText('Matching')).toBeInTheDocument();
    });

    it('renders pending badge with muted variant (ring-border/20) and spinner icon', () => {
      render(<ImportCard {...defaultProps} row={makeRow()} />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-muted/50', 'ring-1', 'ring-border/20');
      expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    });

    it('paused=true: genuinely-new pending row shows "Paused" badge with NO spinner', () => {
      render(<ImportCard {...defaultProps} row={makeRow()} paused />);
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(screen.queryByText('Matching')).not.toBeInTheDocument();
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('bg-muted/50', 'ring-1', 'ring-border/20');
      expect(badge.querySelector('svg')).not.toBeInTheDocument();
    });

    it('paused omitted (default false): pending row keeps the spinning "Matching" badge', () => {
      render(<ImportCard {...defaultProps} row={makeRow()} />);
      expect(screen.getByText('Matching')).toBeInTheDocument();
      expect(screen.queryByText('Paused')).not.toBeInTheDocument();
      expect(screen.getByTestId('badge').querySelector('svg')).toBeInTheDocument();
    });

    it('paused=true has no effect on a matched (high-confidence) row', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ matchResult: makeMatchResult({ confidence: 'high' }) })} paused />);
      expect(screen.getByText('Matched')).toBeInTheDocument();
      expect(screen.queryByText('Paused')).not.toBeInTheDocument();
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

    it('renders a Review (medium) row with selected=false as an unchecked checkbox (#1318)', () => {
      render(
        <ImportCard
          {...defaultProps}
          row={makeRow({ selected: false, matchResult: makeMatchResult({ confidence: 'medium' }) })}
        />,
      );
      expect(screen.getByText('Review')).toBeInTheDocument();
      expect(screen.getByLabelText('Select')).toBeInTheDocument();
      expect(screen.queryByLabelText('Deselect')).not.toBeInTheDocument();
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

  describe('series / #position display', () => {
    it('renders the EDITED series/#position when a non-empty edited series differs from metadata (#1927 AC6)', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'The Dresden Files', seriesPosition: 10, metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Children of Time', position: 3 } } },
        })}
      />);
      expect(screen.getByText('The Dresden Files #10')).toBeInTheDocument();
      expect(screen.queryByText('Children of Time #3')).not.toBeInTheDocument();
    });

    it('renders an untouched matched row from its metadata-seeded edited series (#1927 AC4 no-op)', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Children of Time', seriesPosition: 3, metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Children of Time', position: 3 } } },
        })}
      />);
      expect(screen.getByText('Children of Time #3')).toBeInTheDocument();
    });

    it('CLEARED matched row (edited.series === "") falls back to the metadata primary — the deferred value that imports, NOT blank (#1927 AC6)', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: '', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Children of Time', position: 3 } } },
        })}
      />);
      expect(screen.getByText('Children of Time #3')).toBeInTheDocument();
    });

    it('cleared row shows the metadata series name alone when the primary has no position', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: '', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Standalone Saga' } } },
        })}
      />);
      expect(screen.getByText('Standalone Saga')).toBeInTheDocument();
    });

    it('renders a padded edited series name VERBATIM (no trim) so the row matches the mapper/DB record (#1927 AC5/AC6/F12)', () => {
      const paddedName = ' Padded Saga ';
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: paddedName, seriesPosition: 5, metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Different Primary', position: 9 } } },
        })}
      />);
      // getByText normalizes for the lookup; textContent is the raw, un-normalized render.
      const seriesLine = screen.getByText(/Padded Saga/);
      expect(seriesLine.textContent).toBe(`${paddedName} #5`);
      expect(screen.queryByText('Different Primary #9')).not.toBeInTheDocument();
    });

    it('renders a series position of 0 as #0 on the defer path (not swallowed — #1028 guard)', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: '', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], seriesPrimary: { name: 'Prequels', position: 0 } } },
        })}
      />);
      expect(screen.getByText('Prequels #0')).toBeInTheDocument();
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
      render(<ImportCard {...defaultProps} row={makeRow({ edited: { title: 'Book Title', author: 'Author Name', series: '' } })} />);
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

    it('shows top-level edited.narrators on a No-Match row (no metadata)', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          book: makeBook({ fileCount: 5 }),
          matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }),
          edited: { title: 'The Catcher in the Rye', author: 'J. D. Salinger', series: '', narrators: ['Ray Hagen'] },
        })}
      />);
      expect(screen.getByText(/Ray Hagen/)).toBeInTheDocument();
      expect(screen.queryByText(/5 files/)).not.toBeInTheDocument();
    });

    it('prefers top-level edited.narrators over metadata.narrators when they differ', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name', narrators: ['Ray Hagen'], metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Jim Dale'] } },
        })}
      />);
      expect(screen.getByText(/Ray Hagen/)).toBeInTheDocument();
      expect(screen.queryByText(/Jim Dale/)).not.toBeInTheDocument();
    });

    it('shows the seeded top-level narrator on a matched, never-edited row', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name', narrators: ['Jim Dale'], metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Jim Dale'] } },
        })}
      />);
      expect(screen.getByText(/Jim Dale/)).toBeInTheDocument();
    });

    it('falls back to metadata.narrators when the top-level narrator is cleared on a matched row', () => {
      render(<ImportCard
        {...defaultProps}
        row={makeRow({
          matchResult: makeMatchResult(),
          edited: { title: 'Book Title', author: 'Author Name', series: 'Series Name', metadata: { title: 'Book Title', authors: [{ name: 'Author Name' }], narrators: ['Jim Dale'] } },
        })}
      />);
      expect(screen.getByText(/Jim Dale/)).toBeInTheDocument();
    });

    it('shows singular "1 file" form when fileCount is 1', () => {
      render(<ImportCard {...defaultProps} row={makeRow({ book: makeBook({ fileCount: 1 }) })} />);
      expect(screen.getByText(/1 file[^s]/)).toBeInTheDocument();
      expect(screen.queryByText(/1 files/)).not.toBeInTheDocument();
    });

    it('shows file size', () => {
      render(<ImportCard {...defaultProps} row={makeRow()} />);
      expect(screen.getByText(/500/)).toBeInTheDocument();
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
      const { container } = render(<ImportCard {...defaultProps} row={makeRow()} />);
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

  describe('duplicate rows (isDuplicate: true)', () => {
    const dupRow = makeRow({
      book: makeBook({ isDuplicate: true, existingBookId: 42, duplicateReason: 'slug' }),
      selected: false,
    });

    it('shows "Already owned" badge for a scan-time DB duplicate (isDuplicate + slug reason)', () => {
      render(<ImportCard {...defaultProps} row={dupRow} />);
      expect(screen.getByText('Already owned')).toBeInTheDocument();
    });

    it('renders "Already owned" badge with muted variant and no icon', () => {
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
        // Mirrors Manual Import's force-import path: no match result.
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
      expect(screen.queryByText('Already owned')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Edit metadata/i })).toBeInTheDocument();
    });
  });

  describe('recording-verdict badge ladder (#1712)', () => {
    it('recordingVerdict same-recording → "Already owned"', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'slug', recordingVerdict: 'same-recording' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByText('Already owned')).toBeInTheDocument();
    });

    it('recordingVerdict different-recording → "New version of an owned title" and the row stays selectable', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: false, recordingVerdict: 'different-recording' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByText('New version of an owned title')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /select|deselect/i })).toBeInTheDocument();
    });

    it('recordingVerdict review → "Possible duplicate (review)"', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: false, recordingVerdict: 'review' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByText('Possible duplicate (review)')).toBeInTheDocument();
    });

    it('scan-time path duplicate (no verdict) → "Already owned" via the fallback rung', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'path' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByText('Already owned')).toBeInTheDocument();
    });

    it('genuinely new book (no flags) → no ownership badge, confidence badge shown', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: false }), matchResult: makeMatchResult({ confidence: 'high' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.queryByText('Already owned')).not.toBeInTheDocument();
      expect(screen.queryByText('New version of an owned title')).not.toBeInTheDocument();
      expect(screen.getByText('Matched')).toBeInTheDocument();
    });

    it('a non-duplicate row carrying ONLY reviewReason renders the tooltip indicator but NOT the review badge', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: false, reviewReason: 'Additional non-book content possibly merged' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByTestId('review-reason-indicator')).toBeInTheDocument();
      expect(screen.queryByText('Possible duplicate (review)')).not.toBeInTheDocument();
    });

    it('a recording-review row renders BOTH the badge and the absorbed-content tooltip when both are set', () => {
      const row = makeRow({ book: makeBook({ isDuplicate: false, recordingVerdict: 'review', reviewReason: 'Possible different recording of a book you already own' }) });
      render(<ImportCard {...defaultProps} row={row} />);
      expect(screen.getByText('Possible duplicate (review)')).toBeInTheDocument();
      expect(screen.getByTestId('review-reason-indicator')).toBeInTheDocument();
    });
  });

  describe('confidence reason display (#415)', () => {
    it('medium confidence with reason string → reason text visible via title attribute', () => {
      const row = makeRow({
        matchResult: makeMatchResult({
          confidence: 'medium',
          reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review');
      expect(badge.closest('[title]')).toBeTruthy();
      expect(badge.closest('[title]')!.getAttribute('title')).toBe(
        'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
      );
    });

    it('medium confidence without reason (undefined) → badge renders normally without title attribute', () => {
      const row = makeRow({
        matchResult: makeMatchResult({ confidence: 'medium' }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review');
      const titleEl = badge.closest('[title]');
      expect(titleEl === null || titleEl.getAttribute('title') === '').toBe(true);
    });

    it('high confidence → no title attribute on badge', () => {
      const row = makeRow({
        matchResult: makeMatchResult({ confidence: 'high' }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Matched');
      const titleEl = badge.closest('[title]');
      expect(titleEl === null || titleEl.getAttribute('title') === '').toBe(true);
    });

    it('none confidence → no title attribute on badge', () => {
      const row = makeRow({
        matchResult: makeMatchResult({ confidence: 'none', bestMatch: null }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('No Match');
      const titleEl = badge.closest('[title]');
      expect(titleEl === null || titleEl.getAttribute('title') === '').toBe(true);
    });

    it('AC5 — medium + "Low confidence match. Please verify." reason → Review badge with that tooltip', () => {
      const row = makeRow({
        matchResult: makeMatchResult({
          confidence: 'medium',
          reason: 'Low confidence match. Please verify.',
        }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review').closest('[title]');
      expect(badge).toBeTruthy();
      expect(badge!.getAttribute('title')).toBe('Low confidence match. Please verify.');
    });

    it('AC6 — pre-existing duration-mismatch tooltip behavior unchanged', () => {
      const row = makeRow({
        matchResult: makeMatchResult({
          confidence: 'medium',
          reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review').closest('[title]');
      expect(badge!.getAttribute('title')).toBe(
        'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
      );
    });

    it('AC7 — empty-string reason is treated as no reason (no tooltip on Review badge)', () => {
      const row = makeRow({
        matchResult: makeMatchResult({ confidence: 'medium', reason: '' }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review');
      const titleEl = badge.closest('[title]');
      expect(titleEl === null || titleEl.getAttribute('title') === '').toBe(true);
    });

    it('medium confidence with reason → badge is keyboard-focusable and exposes reason on focus', () => {
      const row = makeRow({
        matchResult: makeMatchResult({
          confidence: 'medium',
          reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        }),
      });
      render(<ImportCard {...defaultProps} row={row} />);
      const badge = screen.getByText('Review').closest('[title]') as HTMLElement;
      expect(badge).toHaveAttribute('tabindex', '0');
      badge.focus();
      expect(badge).toHaveFocus();
      expect(badge).toHaveAttribute('title', 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs');
    });
  });
});

describe('ImportCard — lockDuplicates prop (#133)', () => {
  it('lockDuplicates=false (default): duplicate row renders checkbox (existing Manual Import behavior)', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'path' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /deselect/i })).toBeInTheDocument();
  });

  it('lockDuplicates=true + path-duplicate (duplicateReason=path): no checkbox, no edit button, Already owned badge', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'path' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByText('Already owned')).toBeInTheDocument();
  });

  it('lockDuplicates=true + slug-duplicate (duplicateReason=slug): no checkbox, edit button shown, Already owned badge', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: true, duplicateReason: 'slug' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByText('Already owned')).toBeInTheDocument();
  });

  it('lockDuplicates=true + non-duplicate: normal card with checkbox and edit button', () => {
    const row = makeRow({ book: makeBook({ isDuplicate: false }), matchResult: makeMatchResult() });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.getByRole('button', { name: /deselect/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });
});

/**
 * #2581 — the generic annotation slot that replaced #2091's `copyAtOtherPath`/`existingPath` pair.
 * The card renders whatever the caller hands it; deciding WHICH rows get a copy annotation is the
 * Library Import surface's job and is pinned in `copyAnnotation.test.ts`.
 */
describe('ImportCard — annotation slot (#2581)', () => {
  const slugRow = () => makeRow({
    book: makeBook({ isDuplicate: true, duplicateReason: 'slug', recordingVerdict: 'same-recording' }),
  });
  const copyBadge = { label: 'Duplicate copy', variant: 'warning' } as const;

  // B1
  it('renders the annotation badge instead of the ownership ladder rung it would have shown', () => {
    render(
      <ImportCard row={slugRow()} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates annotation={{ badge: copyBadge }} />,
    );
    expect(screen.getByText('Duplicate copy')).toBeInTheDocument();
    expect(screen.queryByText('Already owned')).not.toBeInTheDocument();
  });

  // B2
  it('renders the note beneath the path with the full text as its tooltip', () => {
    const note = 'Same recording as Robin Hobb/Farseer Trilogy/02 - Royal Assassin';
    render(
      <ImportCard row={slugRow()} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates annotation={{ badge: copyBadge, note }} />,
    );
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.getByTestId('import-card-note')).toHaveAttribute('title', note);
  });

  // B3
  it('outranks a resolved ConfidenceBadge on an otherwise plain row', () => {
    render(
      <ImportCard row={makeRow({ matchResult: makeMatchResult() })} onToggle={vi.fn()} onEdit={vi.fn()} annotation={{ badge: copyBadge }} />,
    );
    expect(screen.getByText('Duplicate copy')).toBeInTheDocument();
    expect(screen.queryByText('Matched')).not.toBeInTheDocument();
  });

  it('outranks both the pending spinner and the paused badge (annotation x paused)', () => {
    render(
      <ImportCard row={makeRow()} onToggle={vi.fn()} onEdit={vi.fn()} paused annotation={{ badge: copyBadge }} />,
    );
    expect(screen.getByText('Duplicate copy')).toBeInTheDocument();
    expect(screen.queryByText('Matching')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
  });

  // B4 / B4a / B4b — absent, empty, and blank are three distinct inputs the slot's type admits,
  // and no single production mutation separates all three.
  it.each([
    ['an omitted note', undefined],
    ['an empty note', ''],
    ['a whitespace-only note', '   '],
  ])('renders no note element at all for %s', (_label, note) => {
    render(
      <ImportCard
        row={slugRow()}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        lockDuplicates
        annotation={{ badge: copyBadge, ...(note !== undefined && { note }) }}
      />,
    );
    expect(screen.queryByTestId('import-card-note')).not.toBeInTheDocument();
  });

  // B4c
  it('renders a note carrying incidental whitespace VERBATIM (trim classifies only)', () => {
    const padded = '  Same recording as A/B  ';
    render(
      <ImportCard row={slugRow()} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates annotation={{ badge: copyBadge, note: padded }} />,
    );
    // getByText normalizes for the lookup; textContent is the raw, un-normalized render.
    const noteEl = screen.getByTestId('import-card-note');
    expect(noteEl.textContent).toBe(padded);
    expect(noteEl).toHaveAttribute('title', padded);
  });

  // B5 — this spec's AC3: without an annotation the card is exactly what it was.
  it('leaves the ownership ladder and the note-free layout intact when no annotation is supplied', () => {
    render(<ImportCard row={slugRow()} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
    expect(screen.getByText('Already owned')).toBeInTheDocument();
    expect(screen.queryByText('Duplicate copy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-card-note')).not.toBeInTheDocument();
  });

  // B6 — independent channels.
  it('renders the review-reason indicator alongside an annotation', () => {
    const row = makeRow({ book: makeBook({ reviewReason: 'Runtime differs by 40%' }) });
    render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} annotation={{ badge: copyBadge }} />);
    expect(screen.getByText('Duplicate copy')).toBeInTheDocument();
    expect(screen.getByTestId('review-reason-indicator')).toBeInTheDocument();
  });

  // B7 — the slot is display-only; it must not reopen selection the duplicate rules closed.
  it('keeps a locked slug duplicate unselectable while retaining the edit affordance', () => {
    render(
      <ImportCard row={slugRow()} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates annotation={{ badge: copyBadge, note: 'Same recording as A/B' }} />,
    );
    expect(screen.queryByRole('button', { name: /select|deselect/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  // B8 — the slot is generic, not the two-variant ownership enum in disguise.
  it('renders a badge variant the internal ladder never produces', () => {
    render(
      <ImportCard row={makeRow()} onToggle={vi.fn()} onEdit={vi.fn()} annotation={{ badge: { label: 'Queued elsewhere', variant: 'info' } }} />,
    );
    const badge = screen.getByText('Queued elsewhere');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('text-blue-400');
  });
});

/**
 * #2581 AC8/AC9 — `onToggle` is optional so a read-only row does not have to invent a noop.
 * These pins deliberately sit on a row the duplicate rules do NOT already suppress: on a
 * `lockDuplicates` slug row the checkbox is absent for the pre-existing reason, so the assertion
 * would pass whether or not the `onToggle` guard exists.
 */
describe('ImportCard — optional onToggle (#2581)', () => {
  const selectableRow = () => makeRow({ matchResult: makeMatchResult() });

  // B9
  it('renders no checkbox on a genuinely selectable row when onToggle is omitted', () => {
    render(<ImportCard row={selectableRow()} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^select$|^deselect$/i })).not.toBeInTheDocument();
    // Every other affordance is untouched.
    expect(screen.getByText('Book Title')).toBeInTheDocument();
    expect(screen.getByText('Author Name/Series Name/Book Title')).toBeInTheDocument();
    expect(screen.getByText('Matched')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
  });

  // B10 — the positive half, so B9's negative is not a solo observation.
  it('renders a working checkbox on that same row when onToggle IS supplied', async () => {
    const onToggle = vi.fn();
    render(<ImportCard row={selectableRow()} onToggle={onToggle} onEdit={vi.fn()} />);

    const checkbox = screen.getByRole('button', { name: /^deselect$/i });
    await userEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledOnce();
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
    expect(screen.getByText('audiobooks/Author/Book')).toBeInTheDocument();
  });

  describe('former within-scan rows (#1925)', () => {
    // Former within-scan collisions are normal candidates carrying only a review hint.
    const WITHIN_SCAN_HINT = 'Possible duplicate folder in this scan';

    it('renders the review-reason indicator and no "Duplicate in scan" badge', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: false, reviewReason: WITHIN_SCAN_HINT }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.queryByText('Duplicate in scan')).not.toBeInTheDocument();
      const indicator = screen.getByTestId('review-reason-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveAttribute('title', WITHIN_SCAN_HINT);
    });

    it('paused=true: a result-less former within-scan row shows the normal "Paused" badge', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: false, reviewReason: WITHIN_SCAN_HINT }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates paused />);
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(screen.queryByText('Duplicate in scan')).not.toBeInTheDocument();
    });

    it('has a visible checkbox (selectable) even when lockDuplicates is true', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: false, reviewReason: WITHIN_SCAN_HINT }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} lockDuplicates />);
      expect(screen.getByRole('button', { name: /select|deselect/i })).toBeInTheDocument();
    });

    it('has an edit button shown even when lockDuplicates is true', () => {
      const row = makeRow({
        book: makeBook({ isDuplicate: false, reviewReason: WITHIN_SCAN_HINT }),
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

  describe('reviewReason tooltip (#1031)', () => {
    it('renders an indicator with the reviewReason as title attribute when set', () => {
      const row = makeRow({
        book: makeBook({ reviewReason: 'Additional non-book content possibly merged' }),
        matchResult: makeMatchResult({ confidence: 'high' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      const indicator = screen.getByTestId('review-reason-indicator');
      expect(indicator).toHaveAttribute('title', 'Additional non-book content possibly merged');
    });

    it('omits the indicator when reviewReason is undefined', () => {
      const row = makeRow({ book: makeBook(), matchResult: makeMatchResult({ confidence: 'high' }) });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      expect(screen.queryByTestId('review-reason-indicator')).not.toBeInTheDocument();
    });

    it('renders even on high-confidence rows (independent of ConfidenceBadge medium-only reason)', () => {
      const row = makeRow({
        book: makeBook({ reviewReason: 'Additional non-book content possibly merged' }),
        matchResult: makeMatchResult({ confidence: 'high' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      expect(screen.getByText('Matched')).toBeInTheDocument();
      expect(screen.getByTestId('review-reason-indicator')).toHaveAttribute(
        'title',
        'Additional non-book content possibly merged',
      );
    });

    it('indicator is keyboard-focusable so the tooltip is reachable without a mouse', () => {
      const row = makeRow({
        book: makeBook({ reviewReason: 'Additional non-book content possibly merged' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      const indicator = screen.getByTestId('review-reason-indicator');
      expect(indicator).toHaveAttribute('tabindex', '0');
    });
  });

  describe('audio preview button (#1017)', () => {
    it('renders preview button when previewUrl is present', () => {
      const row = makeRow({
        book: makeBook({ previewUrl: '/api/import/preview/abc123' }),
      });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
    });

    it('omits preview button when previewUrl is undefined', () => {
      const row = makeRow({ book: makeBook() });
      render(<ImportCard row={row} onToggle={vi.fn()} onEdit={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /play preview/i })).not.toBeInTheDocument();
    });

    it('clicking preview does NOT trigger onToggle or onEdit', async () => {
      const onToggle = vi.fn();
      const onEdit = vi.fn();
      const row = makeRow({
        book: makeBook({ previewUrl: '/api/import/preview/xyz' }),
      });
      render(<ImportCard row={row} onToggle={onToggle} onEdit={onEdit} />);

      await userEvent.click(screen.getByRole('button', { name: /play preview/i }));

      expect(onToggle).not.toHaveBeenCalled();
      expect(onEdit).not.toHaveBeenCalled();
    });
  });
});
