import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportSummaryBar } from './ImportSummaryBar';

function renderBar(overrides?: Record<string, unknown>) {
  const defaults = {
    readyCount: 0,
    reviewCount: 0,
    noMatchCount: 0,
    pendingCount: 0,
    selectedCount: 0,
    selectedUnmatchedCount: 0,
    duplicateCount: 0,
    isMatching: false,
    mode: 'copy' as const,
    onModeChange: vi.fn(),
    onImport: vi.fn(),
    importing: false,
  };
  return render(<ImportSummaryBar {...defaults} {...overrides} />);
}

describe('ImportSummaryBar', () => {
  describe('count displays', () => {
    it('shows ready count when > 0', () => {
      renderBar({ readyCount: 5 });
      expect(screen.getByText('5 ready')).toBeInTheDocument();
    });

    it('hides ready count when 0', () => {
      renderBar({ readyCount: 0 });
      expect(screen.queryByText(/ready/)).not.toBeInTheDocument();
    });

    it('shows review count when > 0', () => {
      renderBar({ reviewCount: 3 });
      expect(screen.getByText('3 review')).toBeInTheDocument();
    });

    it('shows no match count when > 0', () => {
      renderBar({ noMatchCount: 2 });
      expect(screen.getByText('2 no match')).toBeInTheDocument();
    });

    it('shows pending/matching count when > 0', () => {
      renderBar({ pendingCount: 4 });
      expect(screen.getByText('4 matching')).toBeInTheDocument();
    });

    it('shows already-in-library count when duplicates present', () => {
      renderBar({ duplicateCount: 1 });
      expect(screen.getByText(/1 already in library/)).toBeInTheDocument();
    });

    it('shows already-in-library count with multiple duplicates', () => {
      renderBar({ duplicateCount: 3 });
      expect(screen.getByText(/3 already in library/)).toBeInTheDocument();
    });

    it('hides already-in-library when duplicateCount is 0', () => {
      renderBar({ duplicateCount: 0 });
      expect(screen.queryByText(/already in library/)).not.toBeInTheDocument();
    });
  });

  describe('import button disable conditions', () => {
    it('disabled when selectedCount is 0', () => {
      renderBar({ selectedCount: 0 });
      expect(screen.getByRole('button', { name: /Import 0/ })).toBeDisabled();
    });

    it('disabled when selected rows have unmatched books', () => {
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 1 });
      expect(screen.getByRole('button', { name: /Import 3/ })).toBeDisabled();
    });

    it('disabled while matching is in progress', () => {
      renderBar({ selectedCount: 3, isMatching: true });
      expect(screen.getByRole('button', { name: /Import 3/ })).toBeDisabled();
    });

    it('disabled while import is pending', () => {
      renderBar({ selectedCount: 3, importing: true });
      expect(screen.getByRole('button', { name: /Importing/ })).toBeDisabled();
    });

    it('enabled when books selected, all matched, not importing', () => {
      renderBar({ selectedCount: 5, selectedUnmatchedCount: 0, isMatching: false, importing: false });
      expect(screen.getByRole('button', { name: /Import 5/ })).toBeEnabled();
    });
  });

  describe('import button text', () => {
    it('shows count of selected books', () => {
      renderBar({ selectedCount: 7 });
      expect(screen.getByRole('button', { name: /Import 7 books/ })).toBeInTheDocument();
    });

    it('singular when 1 book selected', () => {
      renderBar({ selectedCount: 1 });
      expect(screen.getByRole('button', { name: /Import 1 book$/ })).toBeInTheDocument();
    });

    it('shows "Importing..." when import is pending', () => {
      renderBar({ selectedCount: 3, importing: true });
      expect(screen.getByText('Importing...')).toBeInTheDocument();
    });
  });

  describe('tooltip', () => {
    it('shows tooltip explaining why button is disabled when unmatched selected', () => {
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 2 });
      const btn = screen.getByRole('button', { name: /Import/ });
      expect(btn).toHaveAttribute('title', '2 selected books need a match');
    });

    it('singular tooltip for 1 unmatched', () => {
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 1 });
      const btn = screen.getByRole('button', { name: /Import/ });
      expect(btn).toHaveAttribute('title', '1 selected book needs a match');
    });

    it('no tooltip when all matched', () => {
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 0 });
      const btn = screen.getByRole('button', { name: /Import/ });
      expect(btn).not.toHaveAttribute('title');
    });
  });

  describe('mode selection', () => {
    it('shows Copy and Move options', () => {
      renderBar();
      const select = screen.getByRole('combobox');
      expect(select).toHaveValue('copy');
    });

    it('calls onModeChange when mode changes', async () => {
      const onModeChange = vi.fn();
      renderBar({ onModeChange });

      await userEvent.selectOptions(screen.getByRole('combobox'), 'move');
      await waitFor(() => {
        expect(onModeChange).toHaveBeenCalledWith('move');
      });
    });
  });

  describe('import action', () => {
    it('calls onImport when button clicked', async () => {
      const onImport = vi.fn();
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 0, onImport });

      await userEvent.click(screen.getByRole('button', { name: /Import 3/ }));
      await waitFor(() => {
        expect(onImport).toHaveBeenCalledOnce();
      });
    });
  });

  // ===========================================================================
  // #114 — duplicateCount pill replaces skippedDuplicates
  // ===========================================================================
  describe('duplicate count pill', () => {
    it('shows "N already in library" when duplicateCount > 0', () => {
      renderBar({ duplicateCount: 3 });
      expect(screen.getByText(/3 already in library/)).toBeInTheDocument();
    });

    it('pluralizes correctly for duplicateCount === 1', () => {
      renderBar({ duplicateCount: 1 });
      expect(screen.getByText(/1 already in library/)).toBeInTheDocument();
    });

    it('hides the already-in-library pill when duplicateCount is 0', () => {
      renderBar({ duplicateCount: 0 });
      expect(screen.queryByText(/already in library/)).not.toBeInTheDocument();
    });

    it('existing ready / review / no match / matching pills still show alongside duplicateCount', () => {
      renderBar({ readyCount: 5, reviewCount: 2, noMatchCount: 1, duplicateCount: 3 });
      expect(screen.getByText('5 ready')).toBeInTheDocument();
      expect(screen.getByText('2 review')).toBeInTheDocument();
      expect(screen.getByText('1 no match')).toBeInTheDocument();
      expect(screen.getByText(/3 already in library/)).toBeInTheDocument();
    });

    it('does not show old "skipped" text anywhere', () => {
      renderBar({ duplicateCount: 5 });
      expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
    });
  });
});

describe('ImportSummaryBar — hideMode prop (#133)', () => {
  it('hideMode=true: Copy/Move dropdown not rendered', () => {
    renderBar({ hideMode: true });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('hideMode absent: Copy/Move dropdown still renders (Manual Import backward compat)', () => {
    renderBar();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('count badges display correctly when hideMode=true', () => {
    renderBar({ hideMode: true, readyCount: 3, reviewCount: 2 });
    expect(screen.getByText('3 ready')).toBeInTheDocument();
    expect(screen.getByText('2 review')).toBeInTheDocument();
  });
});

describe('ImportSummaryBar — registerLabel prop (#133)', () => {
  it('registerLabel overrides default Import X books CTA text', () => {
    renderBar({ selectedCount: 5, registerLabel: 'Register 5 books' });
    expect(screen.getByRole('button', { name: 'Register 5 books' })).toBeInTheDocument();
    expect(screen.queryByText(/import 5 books/i)).not.toBeInTheDocument();
  });

  it('button text shows custom label when provided', () => {
    renderBar({ selectedCount: 1, registerLabel: 'Add to Library' });
    expect(screen.getByRole('button', { name: 'Add to Library' })).toBeInTheDocument();
  });

  it('registerLabel shown in pending state instead of hardcoded Importing...', () => {
    renderBar({ selectedCount: 2, importing: true, registerLabel: 'Registering...' });
    expect(screen.getByText('Registering...')).toBeInTheDocument();
    expect(screen.queryByText('Importing...')).not.toBeInTheDocument();
  });

  it('disabled=true: button is disabled regardless of selectedCount', () => {
    renderBar({ selectedCount: 3, disabled: true });
    expect(screen.getByRole('button', { name: /import/i })).toBeDisabled();
  });
});
