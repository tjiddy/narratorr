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

describe('queryKeys.bookSeries (#1561)', () => {
  it('returns the singular `book`/`series` tuple', () => {
    expect(queryKeys.bookSeries(7)).toEqual(['book', 7, 'series']);
  });

  it('bookSeriesSearch is a prefix-extension of bookSeries', () => {
    expect(queryKeys.bookSeriesSearch(7, 'foo')).toEqual(['book', 7, 'series', 'search', 'foo']);
  });

  it('invalidating bookSeries also invalidates the in-flight series search (prefix match)', async () => {
    const qc = new QueryClient();
    const seriesKey = queryKeys.bookSeries(7);
    const searchKey = queryKeys.bookSeriesSearch(7, 'foo');

    qc.setQueryData(seriesKey, { series: null });
    qc.setQueryData(searchKey, { candidates: [] });

    expect(qc.getQueryState(seriesKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(searchKey)?.isInvalidated).toBe(false);

    await qc.invalidateQueries({ queryKey: queryKeys.bookSeries(7) });

    expect(qc.getQueryState(seriesKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(searchKey)?.isInvalidated).toBe(true);
  });

  it('invalidating one book id does not touch another', async () => {
    const qc = new QueryClient();
    const key7 = queryKeys.bookSeries(7);
    const key8 = queryKeys.bookSeries(8);

    qc.setQueryData(key7, { series: null });
    qc.setQueryData(key8, { series: null });

    await qc.invalidateQueries({ queryKey: queryKeys.bookSeries(7) });

    expect(qc.getQueryState(key7)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(key8)?.isInvalidated).toBe(false);
  });
});
