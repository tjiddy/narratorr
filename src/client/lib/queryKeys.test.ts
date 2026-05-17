import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';

describe('queryKeys.libraryBooks (#1132)', () => {
  it('returns a tuple beginning with the `books` prefix', () => {
    expect(queryKeys.libraryBooks()).toEqual(['books', 'library']);
    expect(queryKeys.libraryBooks({ limit: 10 })).toEqual(['books', 'library', { limit: 10 }]);
  });

  it('invalidating the books prefix also invalidates library-books (TanStack default prefix match)', async () => {
    const qc = new QueryClient();
    const bookListKey = queryKeys.books({ status: 'wanted' });
    const libraryKey = queryKeys.libraryBooks({ status: 'wanted' });

    qc.setQueryData(bookListKey, { data: [], total: 0 });
    qc.setQueryData(libraryKey, { data: [], total: 0 });

    expect(qc.getQueryState(bookListKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(libraryKey)?.isInvalidated).toBe(false);

    await qc.invalidateQueries({ queryKey: queryKeys.books() });

    expect(qc.getQueryState(bookListKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(libraryKey)?.isInvalidated).toBe(true);
  });

  it('library-books cache is NOT touched when invalidating an unrelated namespace', async () => {
    const qc = new QueryClient();
    const libraryKey = queryKeys.libraryBooks({ limit: 100 });
    qc.setQueryData(libraryKey, { data: [], total: 0 });

    await qc.invalidateQueries({ queryKey: queryKeys.activity() });

    expect(qc.getQueryState(libraryKey)?.isInvalidated).toBe(false);
  });
});
