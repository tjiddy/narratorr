import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  setMergeProgress,
  applyMergeStateSnapshot,
  useMergeProgress,
  useMergeActivityCards,
  _resetForTesting,
} from './useMergeProgress';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';

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

  it('returns terminal state with outcome during dismiss window (not null)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current).toMatchObject({ phase: 'complete', outcome: 'success' });
  });

  it('returns MergeProgress with outcome: success when merge completes (terminal state visible during dismiss window)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current).toMatchObject({ phase: 'complete', outcome: 'success' });
  });

  it('returns MergeProgress with outcome: error when merge fails (terminal state visible during dismiss window)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'failed',
        outcome: 'error',
        error: 'ffmpeg crashed',
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current).toMatchObject({ phase: 'failed', outcome: 'error' });
  });

  it('returns MergeProgress with outcome: cancelled when merge is cancelled (terminal state visible during dismiss window)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'cancelled',
        outcome: 'cancelled',
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current).toMatchObject({ phase: 'cancelled', outcome: 'cancelled' });
  });

  it('returns null after DISMISS_DELAY_MS elapses for terminal entries (existing cleanup preserved)', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, {
        bookTitle: 'Test',
        phase: 'complete',
        outcome: 'success',
        message: 'done',
      });
    });

    expect(result.current).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toBeNull();
  });
});

describe('useMergeActivityCards (list-returning hook)', () => {
  it('returns empty array when no merge events received', () => {
    const { result } = renderHook(() => useMergeActivityCards());
    expect(result.current).toEqual([]);
  });

  it('returns entry with bookTitle, phase, percentage for a starting merge', () => {
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

  it('updates phase and percentage in place (preserves bookTitle)', () => {
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

  it('preserves bookTitle from the queued entry through subsequent phase transitions', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'Queued Book', phase: 'queued', position: 2 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'Queued Book', phase: 'starting' });
    });

    expect(result.current[0]!.bookTitle).toBe('Queued Book');
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

  it('handles a progress write for an unseen book (creates entry with title)', () => {
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

  it('updates queue position in place', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 3 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 1 });
    });

    expect(result.current[0]).toMatchObject({ phase: 'queued', position: 1 });
  });

  it('transitions from queued to starting', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'queued', position: 1 });
    });
    act(() => {
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });

    expect(result.current[0]!.phase).toBe('starting');
    expect(result.current[0]!.position).toBeUndefined();
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
      setMergeProgress(42, { bookTitle: 'My Book', phase: 'starting' });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.phase).toBe('starting');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.phase).toBe('starting');
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

    expect(result.current[0]!.enrichmentWarning).toBe('Metadata update failed');
  });
});

describe('applyMergeStateSnapshot', () => {
  const snapshot = (over: Partial<MergeStateSnapshot> = {}): MergeStateSnapshot => ({
    active: [], queued: [], ...over,
  });

  it('installs active entries with their phase and percentage', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      applyMergeStateSnapshot(snapshot({
        active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing', percentage: 0.35 }],
      }));
    });

    expect(result.current).toEqual({ phase: 'processing', percentage: 0.35 });
  });

  it('derives queued positions from FIFO index, not from a payload field', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      applyMergeStateSnapshot(snapshot({
        queued: [
          { book_id: 43, book_title: 'The Shining' },
          { book_id: 44, book_title: 'It' },
        ],
      }));
    });

    expect(result.current).toEqual([
      { bookId: 43, bookTitle: 'The Shining', phase: 'queued', position: 1 },
      { bookId: 44, bookTitle: 'It', phase: 'queued', position: 2 },
    ]);
  });

  it('removes a book the snapshot no longer mentions', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      applyMergeStateSnapshot(snapshot({ active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'staging' }] }));
    });
    expect(result.current).not.toBeNull();

    act(() => { applyMergeStateSnapshot(snapshot()); });

    expect(result.current).toBeNull();
  });

  it('moves a book from queued to active in place', () => {
    const { result } = renderHook(() => useMergeProgress(43));

    act(() => {
      applyMergeStateSnapshot(snapshot({ queued: [{ book_id: 43, book_title: 'The Shining' }] }));
    });
    expect(result.current).toEqual({ phase: 'queued', position: 1 });

    act(() => {
      applyMergeStateSnapshot(snapshot({ active: [{ book_id: 43, book_title: 'The Shining', phase: 'starting' }] }));
    });

    expect(result.current).toEqual({ phase: 'starting' });
  });

  it('keeps a book inside its terminal dismiss window even though the snapshot omits it', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { bookTitle: 'Dogs of War', phase: 'complete', outcome: 'success', message: 'Merged 3 files' });
    });

    act(() => { applyMergeStateSnapshot(snapshot()); });

    expect(result.current).toMatchObject({ phase: 'complete', outcome: 'success' });

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current).toBeNull();
  });

  it('survives the production terminal sequence: terminal event, then the cleared snapshot', () => {
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      applyMergeStateSnapshot(snapshot({ active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'committing' }] }));
    });

    // The server emits the terminal event before broadcasting the cleared snapshot.
    act(() => {
      setMergeProgress(42, { bookTitle: 'Dogs of War', phase: 'complete', outcome: 'success', message: 'Merged 3 files' });
      applyMergeStateSnapshot(snapshot());
    });

    expect(result.current).toEqual([{
      bookId: 42, bookTitle: 'Dogs of War', phase: 'complete', outcome: 'success', message: 'Merged 3 files',
    }]);

    act(() => { vi.advanceTimersByTime(2999); });
    expect(result.current).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toEqual([]);
  });

  it('is clobbered by the inverse sequence — which is why the server must never send it', () => {
    // A stale active snapshot overwrites the terminal outcome and cancels its dismissal.
    const { result } = renderHook(() => useMergeActivityCards());

    act(() => {
      setMergeProgress(42, { bookTitle: 'Dogs of War', phase: 'complete', outcome: 'success', message: 'Merged 3 files' });
      applyMergeStateSnapshot(snapshot({ active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'committing' }] }));
    });

    expect(result.current[0]).toEqual({ bookId: 42, bookTitle: 'Dogs of War', phase: 'committing' });

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current).toHaveLength(1);

    act(() => { applyMergeStateSnapshot(snapshot()); });
    expect(result.current).toEqual([]);
  });

  it('notifies subscribers exactly once per snapshot, however many books it carries', () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useMergeActivityCards(); });
    const before = renders;

    act(() => {
      applyMergeStateSnapshot(snapshot({
        active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing', percentage: 0.5 }],
        queued: [{ book_id: 43, book_title: 'The Shining' }, { book_id: 44, book_title: 'It' }],
      }));
    });

    expect(renders).toBe(before + 1);
  });

  it('does not churn subscribers on a repeated identical snapshot beyond its single notify', () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useMergeActivityCards(); });
    const identical = snapshot({ active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'staging' }] });

    act(() => { applyMergeStateSnapshot(identical); });
    const afterFirst = renders;
    act(() => { applyMergeStateSnapshot(identical); });

    expect(renders).toBe(afterFirst + 1);
  });
});
