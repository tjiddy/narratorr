import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    const onCancel = vi.fn();

    it('shows cancel button during queued phase', () => {
      render(<MergeCard state={makeState({ phase: 'queued' })} onCancel={onCancel} />);
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeInTheDocument();
    });

    it('shows cancel button during staging phase', () => {
      render(<MergeCard state={makeState({ phase: 'staging' })} onCancel={onCancel} />);
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeInTheDocument();
    });

    it('shows cancel button during processing phase', () => {
      render(<MergeCard state={makeState({ phase: 'processing' })} onCancel={onCancel} />);
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeInTheDocument();
    });

    it('shows cancel button during verifying phase', () => {
      render(<MergeCard state={makeState({ phase: 'verifying' })} onCancel={onCancel} />);
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeInTheDocument();
    });

    it('hides cancel button during committing phase', () => {
      render(<MergeCard state={makeState({ phase: 'committing' })} onCancel={onCancel} />);
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('hides cancel button for complete outcome', () => {
      render(<MergeCard state={makeState({ phase: 'complete', outcome: 'success' })} onCancel={onCancel} />);
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('hides cancel button for error outcome', () => {
      render(<MergeCard state={makeState({ phase: 'failed', outcome: 'error' })} onCancel={onCancel} />);
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('hides cancel button for cancelled outcome', () => {
      render(<MergeCard state={makeState({ phase: 'cancelled', outcome: 'cancelled' })} onCancel={onCancel} />);
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });

    it('hides cancel button when no onCancel prop is provided', () => {
      render(<MergeCard state={makeState({ phase: 'staging' })} />);
      expect(screen.queryByRole('button', { name: /cancel merge/i })).not.toBeInTheDocument();
    });
  });

  describe('hover state', () => {
    it('container includes hover classes and transition matching DownloadCard', () => {
      const { container } = render(<MergeCard state={makeState({ phase: 'starting' })} />);
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('transition-all');
      expect(card.className).toContain('duration-300');
    });

    it('hover classes are present regardless of merge phase (processing, complete, failed)', () => {
      const phases = [
        makeState({ phase: 'processing', percentage: 0.5 }),
        makeState({ phase: 'complete', outcome: 'success', message: 'done' }),
        makeState({ phase: 'failed', outcome: 'error', error: 'fail' }),
      ];
      for (const state of phases) {
        const { container, unmount } = render(<MergeCard state={state} />);
        const card = container.firstElementChild as HTMLElement;
        expect(card.className).toContain('transition-all');
        expect(card.className).toContain('duration-300');
        unmount();
      }
    });
  });

  describe('cancel interaction', () => {
    it('clicking cancel calls onCancel with correct bookId', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      render(<MergeCard state={makeState({ phase: 'processing', bookId: 42 })} onCancel={onCancel} />);

      await user.click(screen.getByRole('button', { name: /cancel merge/i }));
      expect(onCancel).toHaveBeenCalledWith(42);
    });

    it('cancel button shows disabled state while cancel request is in-flight', () => {
      const onCancel = vi.fn();
      render(<MergeCard state={makeState({ phase: 'processing' })} onCancel={onCancel} isCancelling />);
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeDisabled();
    });

    it('cancelled state shows "Merge cancelled" text distinct from error', () => {
      render(<MergeCard state={makeState({ phase: 'cancelled', outcome: 'cancelled' })} />);
      expect(screen.getByText('Merge cancelled')).toBeInTheDocument();
      expect(screen.queryByText('Merge failed')).not.toBeInTheDocument();
    });
  });
});
