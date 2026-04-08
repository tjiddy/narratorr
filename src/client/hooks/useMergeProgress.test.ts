import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  setMergeProgress,
  useMergeProgress,
  useMergeActivityCards,
  _resetForTesting,
} from './useMergeProgress';

beforeEach(() => {
  _resetForTesting();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMergeProgress (per-book backward compatibility)', () => {
  it('returns null when no merge is in progress for the book', () => {
    const { result } = renderHook(() => useMergeProgress(42));
    expect(result.current).toBeNull();
  });

  it('returns progress after setMergeProgress is called', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'staging' });
    });

    expect(result.current).toEqual({ phase: 'staging' });
  });

  it('returns null after progress is cleared with null', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'processing', percentage: 0.5 });
    });
    expect(result.current).not.toBeNull();

    act(() => {
      setMergeProgress(42, null);
    });
    expect(result.current).toBeNull();
  });

  it('tracks progress independently per book ID', () => {
    const { result: result1 } = renderHook(() => useMergeProgress(1));
    const { result: result42 } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'processing', percentage: 0.3 });
    });

    expect(result42.current).toEqual({ phase: 'processing', percentage: 0.3 });
    expect(result1.current).toBeNull();
  });

  it('updates percentage during processing phase', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'processing', percentage: 0.25 });
    });
    expect(result.current?.percentage).toBe(0.25);

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'processing', percentage: 0.75 });
    });
    expect(result.current?.percentage).toBe(0.75);
  });

  it('returns { phase: queued, position: 2 } after setMergeProgress with queued state', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'queued', position: 2 });
    });

    expect(result.current).toEqual({ phase: 'queued', position: 2 });
  });

  it('transitions from queued to starting', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'queued', position: 1 });
    });
    expect(result.current).toEqual({ phase: 'queued', position: 1 });

    act(() => {
      setMergeProgress(42, { bookTitle: 'Test', phase: 'starting' });
    });
    expect(result.current).toEqual({ phase: 'starting' });
  });

  it('returns null for terminal entries (they are activity-only)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });

    // Per-book accessor should return null for terminal entries
    // (BookDetails should not show a progress indicator for completed merges)
    expect(result.current).toBeNull();
  });
});

describe('useMergeActivityCards (list-returning hook)', () => {
  it('returns empty array when no merge events received', () => {
    const { result } = renderHook(() => useMergeActivityCards());
    expect(result.current).toEqual([]);
  });

  it('returns entry with bookTitle, phase, percentage after merge_started', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toEqual({
      bookId: 42,
      bookTitle: 'My Book',
      phase: 'starting',
    });
  });

  it('updates phase and percentage on merge_progress (preserves bookTitle)', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'processing', percentage: 0.5 });
    });

    expect(result.current[0]).toEqual({
      bookId: 42,
      bookTitle: 'My Book',
      phase: 'processing',
      percentage: 0.5,
    });
  });

  it('preserves bookTitle from merge_queued through subsequent phase transitions', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'Queued Book', phase: 'queued', position: 2 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'Queued Book', phase: 'starting' });
    });

    expect(result.current[0].bookTitle).toBe('Queued Book');
  });

  it('sets terminal state fields on merge_complete instead of clearing', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'processing', percentage: 0.9 });
    });
    act(() => {
      setMergeProgress(42, {
        bookTitle: 'My Book',
        phase: 'complete',
        outcome: 'success',
        message: 'Merged 3 files',
      });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      bookId: 42,
      bookTitle: 'My Book',
      phase: 'complete',
      outcome: 'success',
      message: 'Merged 3 files',
    });
  });

  it('sets terminal state fields on merge_failed instead of clearing', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'staging' });
    });
    act(() => {
      setMergeProgress(42, {
        bookTitle: 'My Book',
        phase: 'failed',
        outcome: 'error',
        error: 'ffmpeg crashed',
      });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      bookId: 42,
      bookTitle: 'My Book',
      phase: 'failed',
      outcome: 'error',
      error: 'ffmpeg crashed',
    });
  });

  it('schedules dismiss timer on terminal events; entry removed after delay', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'My Book',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });

    expect(result.current).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toHaveLength(0);
  });

  it('handles merge_progress arriving before merge_started (creates entry with title)', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'Late Start', phase: 'processing', percentage: 0.5 });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      bookId: 42,
      bookTitle: 'Late Start',
      phase: 'processing',
      percentage: 0.5,
    });
  });

  it('updates queue position on merge_queue_updated', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 3 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 1 });
    });

    expect(result.current[0]).toMatchObject({ phase: 'queued', position: 1 });
  });

  it('transitions from queued to starting on merge_started', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 1 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });

    expect(result.current[0].phase).toBe('starting');
    expect(result.current[0].position).toBeUndefined();
  });

  it('supports multiple merge cards simultaneously', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(1, { bookTitle: 'Active Book', phase: 'processing', percentage: 0.5 });
      setMergeProgress(2, { bookTitle: 'Queued Book', phase: 'queued', position: 1 });
    });

    expect(result.current).toHaveLength(2);
  });

  it('rapid terminal events on different books each get independent dismiss timers', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(1, { bookTitle: 'Book A', phase: 'complete', outcome: 'success', message: 'done' });
      setMergeProgress(2, { bookTitle: 'Book B', phase: 'failed', outcome: 'error', error: 'fail' });
    });

    expect(result.current).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toHaveLength(0);
  });

  it('clears stale dismiss timer when same book re-enters non-terminal state', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    // Book 42 completes → dismiss timer starts
    act(() => {
      setMergeProgress(42, {
        bookTitle: 'My Book',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });
    expect(result.current).toHaveLength(1);

    // Same book immediately re-enters merge (new merge started within 3s)
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].phase).toBe('starting');

    // After 3s, the stale timer should NOT have fired — card still exists
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].phase).toBe('starting');
  });

  it('includes enrichmentWarning in terminal success state', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'My Book',
        phase: 'complete',
        outcome: 'success',
        message: 'Merged',
        enrichmentWarning: 'Metadata update failed',
      });
    });

    expect(result.current[0].enrichmentWarning).toBe('Metadata update failed');
  });
});
