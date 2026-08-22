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

  // Search cards invalidate only the `books` prefix after an add.
  it('invalidating the books prefix also invalidates book-identifiers (#1916)', async () => {
    const qc = new QueryClient();
    const identifiersKey = queryKeys.bookIdentifiers();

    expect(identifiersKey).toEqual(['books', 'identifiers']);
    qc.setQueryData(identifiersKey, []);
    expect(qc.getQueryState(identifiersKey)?.isInvalidated).toBe(false);

    await qc.invalidateQueries({ queryKey: queryKeys.books() });

    expect(qc.getQueryState(identifiersKey)?.isInvalidated).toBe(true);
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

describe('queryKeys.singularBookRoot (#2541)', () => {
  it('is the bare singular root', () => {
    expect(queryKeys.singularBookRoot()).toEqual(['book']);
  });

  it('marks the series card and its in-flight member search invalidated', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.bookSeries(7), { series: null });
    qc.setQueryData(queryKeys.bookSeriesSearch(7, 'foo'), { candidates: [] });

    await qc.invalidateQueries({ queryKey: queryKeys.singularBookRoot() });

    expect(qc.getQueryState(queryKeys.bookSeries(7))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.bookSeriesSearch(7, 'foo'))?.isInvalidated).toBe(true);
  });

  it('leaves every plural-book and non-book namespace alone', async () => {
    const qc = new QueryClient();
    const untouched = [
      queryKeys.books(),
      queryKeys.libraryBooks(),
      queryKeys.book(7),
      queryKeys.bookIdentifiers(),
      queryKeys.activity(),
      queryKeys.eventHistory.byBookId(7),
      queryKeys.metadata.book('x'),
    ];
    for (const key of untouched) qc.setQueryData(key, {});

    await qc.invalidateQueries({ queryKey: queryKeys.singularBookRoot() });

    for (const key of untouched) {
      expect({ key, invalidated: qc.getQueryState(key)?.isInvalidated }).toEqual({ key, invalidated: false });
    }
  });

  // Accepted coupling (#2541 AC24): the ad-hoc retry-import key hangs off the same root, so it
  // refetches on every status event. Retry availability genuinely tracks status, so it stays.
  it('also marks the undeclared retry-import-available key invalidated', async () => {
    const qc = new QueryClient();
    const retryKey = ['book', 7, 'retry-import-available'];
    qc.setQueryData(retryKey, { available: false });

    await qc.invalidateQueries({ queryKey: queryKeys.singularBookRoot() });

    expect(qc.getQueryState(retryKey)?.isInvalidated).toBe(true);
  });
});
