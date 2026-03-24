import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import Fuse, { type IFuseOptions } from 'fuse.js';
import type { BookWithAuthor } from '@/lib/api';

const DEBOUNCE_MS = 250;

const fuseOptions: IFuseOptions<BookWithAuthor> = {
  keys: [
    { name: 'title', weight: 1.0 },
    { name: 'authors.name', weight: 0.8 },
    { name: 'seriesName', weight: 0.7 },
    { name: 'narrators.name', weight: 0.6 },
    { name: 'genres', weight: 0.4 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
  minMatchCharLength: 2,
};

export function useLibrarySearch(books: BookWithAuthor[]) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(value), DEBOUNCE_MS);
  }, []);

  const clearQuery = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const fuse = useMemo(() => new Fuse(books, fuseOptions), [books]);

  const results = useMemo(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) return books;
    return fuse.search(trimmed).map((r) => r.item);
  }, [fuse, books, debouncedQuery]);

  return {
    query,
    setQuery: handleQueryChange,
    clearQuery,
    results,
    isSearching: debouncedQuery.trim().length > 0,
  };
}

