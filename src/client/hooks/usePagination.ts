import { useState, useCallback } from 'react';

export interface UsePaginationReturn {
  page: number;
  offset: number;
  limit: number;
  setPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  reset: () => void;
  totalPages: (total: number) => number;
  /** Call with current total to clamp page when data shrinks */
  clampToTotal: (total: number) => void;
}

export function usePagination(limit: number): UsePaginationReturn {
  const [page, setPageState] = useState(1);

  const offset = (page - 1) * limit;

  const setPage = useCallback((p: number) => {
    setPageState(Math.max(1, p));
  }, []);

  const nextPage = useCallback(() => {
    setPageState((p) => p + 1);
  }, []);

  const prevPage = useCallback(() => {
    setPageState((p) => Math.max(1, p - 1));
  }, []);

  const reset = useCallback(() => {
    setPageState(1);
  }, []);

  const totalPages = useCallback((total: number) => {
    return Math.max(1, Math.ceil(total / limit));
  }, [limit]);

  const clampToTotal = useCallback((total: number) => {
    const maxPage = Math.max(1, Math.ceil(total / limit));
    setPageState((p) => (p > maxPage ? maxPage : p));
  }, [limit]);

  return { page, offset, limit, setPage, nextPage, prevPage, reset, totalPages, clampToTotal };
}
