import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    skippedDuplicates: 0,
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

    it('shows skipped duplicates count', () => {
      renderBar({ skippedDuplicates: 1 });
      expect(screen.getByText('1 duplicate skipped')).toBeInTheDocument();
    });

    it('pluralizes duplicates correctly', () => {
      renderBar({ skippedDuplicates: 3 });
      expect(screen.getByText('3 duplicates skipped')).toBeInTheDocument();
    });

    it('hides skipped when 0', () => {
      renderBar({ skippedDuplicates: 0 });
      expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
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
      expect(onModeChange).toHaveBeenCalledWith('move');
    });
  });

  describe('import action', () => {
    it('calls onImport when button clicked', async () => {
      const onImport = vi.fn();
      renderBar({ selectedCount: 3, selectedUnmatchedCount: 0, onImport });

      await userEvent.click(screen.getByRole('button', { name: /Import 3/ }));
      expect(onImport).toHaveBeenCalledOnce();
    });
  });
});
