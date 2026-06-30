import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHeldReview } from './useHeldReview';
import type { ImportRow } from '@/components/manual-import';
import type { HeldReviewItem } from '@/lib/api';

function makeRow(path: string, title: string, overrides?: Partial<ImportRow>): ImportRow {
  return {
    book: {
      path,
      parsedTitle: title,
      parsedAuthor: 'Author',
      parsedSeries: null,
      fileCount: 1,
      totalSize: 1000,
      isDuplicate: false,
    },
    selected: true,
    userEdited: false,
    edited: { title, author: 'Author', series: '' },
    ...overrides,
  };
}

const HELD = (path: string, title: string): HeldReviewItem => ({
  path,
  title,
  reason: 'recording-review-required',
});

describe('useHeldReview', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useHeldReview({ rows: [], confirm: vi.fn() }));
    expect(result.current.heldReview).toEqual([]);
    expect(result.current.heldReviewMode).toBeUndefined();
  });

  it('captureHeld records items and the mode snapshot; clearHeld resets both', () => {
    const { result } = renderHook(() => useHeldReview({ rows: [], confirm: vi.fn() }));

    act(() => { result.current.captureHeld([HELD('/a/B1', 'B1')], 'move'); });
    expect(result.current.heldReview).toHaveLength(1);
    expect(result.current.heldReviewMode).toBe('move');

    act(() => { result.current.clearHeld(); });
    expect(result.current.heldReview).toEqual([]);
    expect(result.current.heldReviewMode).toBeUndefined();
  });

  it('handleReconfirmHeld rebuilds held rows by path with forceImport and passes the snapshot mode', () => {
    const confirm = vi.fn();
    const rows = [makeRow('/a/B1', 'B1'), makeRow('/a/B2', 'B2')];
    const { result } = renderHook(() => useHeldReview({ rows, confirm }));

    act(() => { result.current.captureHeld([HELD('/a/B1', 'B1')], 'move'); });
    act(() => { result.current.handleReconfirmHeld(); });

    expect(confirm).toHaveBeenCalledTimes(1);
    const [items, mode] = confirm.mock.calls[0]!;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: '/a/B1', forceImport: true });
    expect(mode).toBe('move');
  });

  it('does not call confirm when no current row matches a held path', () => {
    const confirm = vi.fn();
    const rows = [makeRow('/a/B2', 'B2')];
    const { result } = renderHook(() => useHeldReview({ rows, confirm }));

    act(() => { result.current.captureHeld([HELD('/a/B1', 'B1')], undefined); });
    act(() => { result.current.handleReconfirmHeld(); });

    expect(confirm).not.toHaveBeenCalled();
  });
});
