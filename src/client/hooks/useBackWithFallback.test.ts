import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBackWithFallback } from './useBackWithFallback.js';

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('useBackWithFallback', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('goes browser-back when an in-app entry exists behind this one (idx > 0)', () => {
    window.history.replaceState({ idx: 2 }, '');
    const { result } = renderHook(() => useBackWithFallback('/library'));

    result.current();

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it('navigates to the fallback on a deep link (router idx 0 — nothing in-app behind)', () => {
    window.history.replaceState({ idx: 0 }, '');
    const { result } = renderHook(() => useBackWithFallback('/library'));

    result.current();

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/library');
  });

  it('navigates to the fallback when history state is absent entirely (external arrival)', () => {
    window.history.replaceState(null, '');
    const { result } = renderHook(() => useBackWithFallback('/library'));

    result.current();

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/library');
  });
});
