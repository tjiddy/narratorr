import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBookModals } from './useBookModals';

describe('useBookModals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all 7 modal keys with initial false state', () => {
    const { result } = renderHook(() => useBookModals());

    expect(result.current.modals).toEqual({
      search: false,
      edit: false,
      confirmRename: false,
      confirmRetag: false,
      confirmMerge: false,
      confirmDelete: false,
      confirmWrongRelease: false,
    });
  });

  it('open("search") sets search to true, others remain false', () => {
    const { result } = renderHook(() => useBookModals());

    act(() => result.current.open('search'));

    expect(result.current.modals.search).toBe(true);
    expect(result.current.modals.edit).toBe(false);
    expect(result.current.modals.confirmRename).toBe(false);
    expect(result.current.modals.confirmRetag).toBe(false);
    expect(result.current.modals.confirmMerge).toBe(false);
    expect(result.current.modals.confirmDelete).toBe(false);
    expect(result.current.modals.confirmWrongRelease).toBe(false);
  });

  it('close("edit") sets edit to false', () => {
    const { result } = renderHook(() => useBookModals());

    act(() => result.current.open('edit'));
    expect(result.current.modals.edit).toBe(true);

    act(() => result.current.close('edit'));
    expect(result.current.modals.edit).toBe(false);
  });

  it('multiple modals can be open simultaneously (no mutual exclusion)', () => {
    const { result } = renderHook(() => useBookModals());

    act(() => {
      result.current.open('search');
      result.current.open('edit');
      result.current.open('confirmDelete');
    });

    expect(result.current.modals.search).toBe(true);
    expect(result.current.modals.edit).toBe(true);
    expect(result.current.modals.confirmDelete).toBe(true);
    expect(result.current.modals.confirmRename).toBe(false);
  });

  it('open and close are stable references across renders', () => {
    const { result, rerender } = renderHook(() => useBookModals());

    const firstOpen = result.current.open;
    const firstClose = result.current.close;

    rerender();

    expect(result.current.open).toBe(firstOpen);
    expect(result.current.close).toBe(firstClose);
  });
});
