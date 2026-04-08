import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergeCard } from './MergeCard';
import type { MergeCardState } from '@/hooks/useMergeProgress';

function makeState(overrides: Partial<MergeCardState> = {}): MergeCardState {
  return { bookId: 42, bookTitle: 'Test Book', phase: 'starting', ...overrides };
}

describe('MergeCard', () => {
  describe('phase rendering', () => {
    it('renders book title and "Merge started..." when phase is starting', () => {
      render(<MergeCard state={makeState({ phase: 'starting' })} />);
      expect(screen.getByText('Test Book')).toBeInTheDocument();
      expect(screen.getByText('Merge started...')).toBeInTheDocument();
    });

    it('renders "Staging files..." when phase is staging with no percentage', () => {
      render(<MergeCard state={makeState({ phase: 'staging' })} />);
      expect(screen.getByText('Staging files...')).toBeInTheDocument();
    });

    it('renders progress bar at 50% when processing with percentage 0.5', () => {
      render(<MergeCard state={makeState({ phase: 'processing', percentage: 0.5 })} />);
      expect(screen.getByText(/Encoding to M4B — 50%/)).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '50');
    });

    it('renders "Queued" with position number', () => {
      render(<MergeCard state={makeState({ phase: 'queued', position: 2 })} />);
      expect(screen.getByText('Queued (position 2)')).toBeInTheDocument();
    });

    it('renders 0% progress when percentage is 0', () => {
      render(<MergeCard state={makeState({ phase: 'processing', percentage: 0 })} />);
      expect(screen.getByText(/Encoding to M4B — 0%/)).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    });

    it('renders gracefully when queued with no position field', () => {
      render(<MergeCard state={makeState({ phase: 'queued' })} />);
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });
  });

  describe('terminal states', () => {
    it('renders success state with message', () => {
      render(<MergeCard state={makeState({
        phase: 'complete', outcome: 'success', message: 'Merged 3 files into Test.m4b',
      })} />);
      expect(screen.getByText('Merged 3 files into Test.m4b')).toBeInTheDocument();
    });

    it('renders failure state with error message', () => {
      render(<MergeCard state={makeState({
        phase: 'failed', outcome: 'error', error: 'ffmpeg crashed',
      })} />);
      expect(screen.getByText('ffmpeg crashed')).toBeInTheDocument();
    });

    it('renders enrichmentWarning when present on success', () => {
      render(<MergeCard state={makeState({
        phase: 'complete', outcome: 'success', message: 'Merged',
        enrichmentWarning: 'Metadata update failed',
      })} />);
      expect(screen.getByText('Metadata update failed')).toBeInTheDocument();
    });

    it('does not render enrichmentWarning section when absent on success', () => {
      render(<MergeCard state={makeState({
        phase: 'complete', outcome: 'success', message: 'Merged',
      })} />);
      expect(screen.queryByText(/metadata/i)).not.toBeInTheDocument();
    });
  });

  describe('boundary values', () => {
    it('percentage exactly 1.0 renders as 100%', () => {
      render(<MergeCard state={makeState({ phase: 'processing', percentage: 1.0 })} />);
      expect(screen.getByText(/Encoding to M4B — 100%/)).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('long book title truncates gracefully', () => {
      const longTitle = 'A'.repeat(200);
      render(<MergeCard state={makeState({ bookTitle: longTitle })} />);
      expect(screen.getByText(longTitle)).toBeInTheDocument();
    });

    it('merge_failed with empty error renders generic message', () => {
      render(<MergeCard state={makeState({
        phase: 'failed', outcome: 'error', error: '',
      })} />);
      // "Merge failed" appears as both phase label (subtitle) and fallback error message
      expect(screen.getAllByText('Merge failed')).toHaveLength(2);
    });
  });

  describe('cancel button visibility', () => {
    it.todo('shows cancel button during queued phase');
    it.todo('shows cancel button during staging phase');
    it.todo('shows cancel button during processing phase');
    it.todo('shows cancel button during verifying phase');
    it.todo('hides cancel button during committing phase');
    it.todo('hides cancel button for complete outcome');
    it.todo('hides cancel button for error outcome');
    it.todo('hides cancel button for cancelled outcome');
  });

  describe('cancel interaction', () => {
    it.todo('clicking cancel calls the cancel API with correct bookId');
    it.todo('cancel button shows loading/disabled state while cancel request is in-flight');
    it.todo('after successful cancel, card updates to show Cancelled state distinct from error');
    it.todo('cancelled state uses reason field, not string matching on error message');
    it.todo('cancel failure shows error toast');
  });
});
