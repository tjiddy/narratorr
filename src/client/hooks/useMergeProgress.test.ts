import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { setMergeProgress, useMergeProgress } from './useMergeProgress';

describe('useMergeProgress', () => {
  beforeEach(() => {
    // Clear all progress state between tests
    setMergeProgress(1, null);
    setMergeProgress(42, null);
  });

  it('returns null when no merge is in progress for the book', () => {
    const { result } = renderHook(() => useMergeProgress(42));
    expect(result.current).toBeNull();
  });

  it('returns progress after setMergeProgress is called', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { phase: 'staging' });
    });

    expect(result.current).toEqual({ phase: 'staging' });
  });

  it('returns null after progress is cleared with null', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { phase: 'processing', percentage: 0.5 });
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
      setMergeProgress(42, { phase: 'processing', percentage: 0.3 });
    });

    expect(result42.current).toEqual({ phase: 'processing', percentage: 0.3 });
    expect(result1.current).toBeNull();
  });

  it('updates percentage during processing phase', () => {
    const { result } = renderHook(() => useMergeProgress(42));

    act(() => {
      setMergeProgress(42, { phase: 'processing', percentage: 0.25 });
    });
    expect(result.current?.percentage).toBe(0.25);

    act(() => {
      setMergeProgress(42, { phase: 'processing', percentage: 0.75 });
    });
    expect(result.current?.percentage).toBe(0.75);
  });
});
