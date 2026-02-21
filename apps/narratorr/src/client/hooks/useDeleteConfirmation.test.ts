import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeleteConfirmation } from './useDeleteConfirmation';

describe('useDeleteConfirmation', () => {
  it('starts with no target and isOpen false', () => {
    const { result } = renderHook(() => useDeleteConfirmation<{ id: number; name: string }>());

    expect(result.current.target).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it('requestDelete sets target and isOpen becomes true', () => {
    const { result } = renderHook(() => useDeleteConfirmation<{ id: number; name: string }>());
    const item = { id: 1, name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    expect(result.current.target).toEqual(item);
    expect(result.current.isOpen).toBe(true);
  });

  it('cancel clears target and isOpen becomes false', () => {
    const { result } = renderHook(() => useDeleteConfirmation<{ id: number; name: string }>());
    const item = { id: 1, name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.target).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it('confirm returns the target item and clears state', () => {
    const { result } = renderHook(() => useDeleteConfirmation<{ id: number; name: string }>());
    const item = { id: 1, name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    let confirmed: { id: number; name: string } | null = null;
    act(() => {
      confirmed = result.current.confirm();
    });

    expect(confirmed).toEqual(item);
    expect(result.current.target).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it('confirm returns null when no target is set', () => {
    const { result } = renderHook(() => useDeleteConfirmation<{ id: number; name: string }>());

    let confirmed: { id: number; name: string } | null = null;
    act(() => {
      confirmed = result.current.confirm();
    });

    expect(confirmed).toBeNull();
  });
});
