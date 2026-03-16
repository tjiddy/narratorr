import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePagination } from './usePagination';

describe('usePagination', () => {
  it('starts on page 1 with offset 0', () => {
    const { result } = renderHook(() => usePagination(50));
    expect(result.current.page).toBe(1);
    expect(result.current.offset).toBe(0);
  });

  it('calculates offset from page and limit', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.setPage(3));
    expect(result.current.offset).toBe(100);
  });

  it('nextPage increments page', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.nextPage());
    expect(result.current.page).toBe(2);
  });

  it('prevPage decrements page but not below 1', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.prevPage());
    expect(result.current.page).toBe(1);
  });

  it('reset returns to page 1', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.setPage(5));
    act(() => result.current.reset());
    expect(result.current.page).toBe(1);
  });

  it('totalPages calculates correctly', () => {
    const { result } = renderHook(() => usePagination(50));
    expect(result.current.totalPages(0)).toBe(1);
    expect(result.current.totalPages(50)).toBe(1);
    expect(result.current.totalPages(51)).toBe(2);
    expect(result.current.totalPages(150)).toBe(3);
  });

  it('clampToTotal snaps back to last valid page when total shrinks', () => {
    const { result } = renderHook(() => usePagination(50));
    // Go to page 5 (items 201-250)
    act(() => result.current.setPage(5));
    expect(result.current.page).toBe(5);

    // Total shrinks to 150 (3 pages max) — should clamp to page 3
    act(() => result.current.clampToTotal(150));
    expect(result.current.page).toBe(3);
  });

  it('clampToTotal does not change page when still valid', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.setPage(2));

    // Total is still big enough for page 2
    act(() => result.current.clampToTotal(150));
    expect(result.current.page).toBe(2);
  });

  it('clampToTotal snaps to page 1 when total is 0', () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => result.current.setPage(3));

    act(() => result.current.clampToTotal(0));
    expect(result.current.page).toBe(1);
  });
});
