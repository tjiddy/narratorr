import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageError } from './useImageError';

describe('useImageError', () => {
  it('starts with hasError false', () => {
    const { result } = renderHook(() => useImageError());

    expect(result.current.hasError).toBe(false);
  });

  it('onError sets hasError to true', () => {
    const { result } = renderHook(() => useImageError());

    act(() => {
      result.current.onError();
    });

    expect(result.current.hasError).toBe(true);
  });

  it('reset clears hasError back to false', () => {
    const { result } = renderHook(() => useImageError());

    act(() => {
      result.current.onError();
    });

    expect(result.current.hasError).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.hasError).toBe(false);
  });
});
