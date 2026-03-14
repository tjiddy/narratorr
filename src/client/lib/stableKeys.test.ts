import { describe, it, expect } from 'vitest';
import { bookMetadataKey, authorMetadataKey, searchResultKey, importListItemKey, deduplicateKeys } from './stableKeys';
import type { BookMetadata, AuthorMetadata, SearchResult } from '@/lib/api';

describe('bookMetadataKey', () => {
  it('produces the same key regardless of array position', () => {
    const book: BookMetadata = {
      asin: 'B001',
      providerId: 'prov1',
      title: 'Test Book',
      authors: [{ name: 'Author A' }],
    };
    expect(bookMetadataKey(book)).toBe('B001-prov1-Test Book-Author A');
  });

  it('uses empty strings for missing optional fields', () => {
    const book: BookMetadata = { title: 'Orphan Book', authors: [] };
    expect(bookMetadataKey(book)).toBe('--Orphan Book-');
  });

  it('generates different keys for same asin but different providerId', () => {
    const book1: BookMetadata = { asin: 'B001', providerId: 'prov1', title: 'Same', authors: [{ name: 'A' }] };
    const book2: BookMetadata = { asin: 'B001', providerId: 'prov2', title: 'Same', authors: [{ name: 'A' }] };
    expect(bookMetadataKey(book1)).not.toBe(bookMetadataKey(book2));
  });

  it('produces identical keys for true duplicates', () => {
    const book: BookMetadata = { asin: 'B001', title: 'Same', authors: [{ name: 'A' }] };
    expect(bookMetadataKey(book)).toBe(bookMetadataKey(book));
  });
});

describe('authorMetadataKey', () => {
  it('uses asin alone when present — no index suffix', () => {
    const author: AuthorMetadata = { asin: 'A001', name: 'Author A' };
    expect(authorMetadataKey(author)).toBe('A001');
  });

  it('uses name + imageUrl when asin is missing', () => {
    const author: AuthorMetadata = { name: 'Author A', imageUrl: 'https://img.com/a.jpg' };
    expect(authorMetadataKey(author)).toBe('Author A-https://img.com/a.jpg');
  });

  it('generates different keys for same name but different imageUrl', () => {
    const a1: AuthorMetadata = { name: 'Same', imageUrl: 'img1.jpg' };
    const a2: AuthorMetadata = { name: 'Same', imageUrl: 'img2.jpg' };
    expect(authorMetadataKey(a1)).not.toBe(authorMetadataKey(a2));
  });

  it('produces the same key regardless of array position', () => {
    const author: AuthorMetadata = { name: 'Same', asin: 'A1' };
    expect(authorMetadataKey(author)).toBe('A1');
  });
});

describe('searchResultKey', () => {
  it('uses infoHash alone when present — no index suffix', () => {
    const result: SearchResult = {
      infoHash: 'abc123',
      title: 'Test',
      protocol: 'torrent',
      indexer: 'idx',
      downloadUrl: 'http://dl.com',
    };
    expect(searchResultKey(result)).toBe('abc123');
  });

  it('uses downloadUrl when infoHash is missing — no index suffix', () => {
    const result: SearchResult = {
      title: 'Test',
      protocol: 'usenet',
      indexer: 'idx',
      downloadUrl: 'http://dl.com/file.nzb',
    };
    expect(searchResultKey(result)).toBe('http://dl.com/file.nzb');
  });

  it('uses composite fields when both infoHash and downloadUrl are missing', () => {
    const result: SearchResult = {
      title: 'Test',
      protocol: 'usenet',
      indexer: 'idx',
      author: 'Author',
      detailsUrl: 'http://details.com',
    };
    expect(searchResultKey(result)).toBe('usenet-idx-Test-Author-http://details.com');
  });

  it('uses rawTitle when author is missing in composite', () => {
    const result: SearchResult = {
      title: 'Test',
      rawTitle: 'Test.Raw',
      protocol: 'torrent',
      indexer: 'idx',
    };
    expect(searchResultKey(result)).toBe('torrent-idx-Test-Test.Raw-');
  });

  it('generates different keys for two results with different downloadUrl', () => {
    const r1: SearchResult = { title: 'Same', protocol: 'usenet', indexer: 'idx', downloadUrl: 'dl1' };
    const r2: SearchResult = { title: 'Same', protocol: 'usenet', indexer: 'idx', downloadUrl: 'dl2' };
    expect(searchResultKey(r1)).not.toBe(searchResultKey(r2));
  });

  it('produces the same key regardless of array position', () => {
    const result: SearchResult = { title: 'T', protocol: 'torrent', indexer: 'i', infoHash: 'abc' };
    expect(searchResultKey(result)).toBe('abc');
  });
});

describe('importListItemKey', () => {
  it('uses asin alone when present — no index suffix', () => {
    expect(importListItemKey({ title: 'T', asin: 'A1' })).toBe('A1');
  });

  it('uses isbn when asin is missing', () => {
    expect(importListItemKey({ title: 'T', isbn: 'ISBN1' })).toBe('ISBN1');
  });

  it('uses title + author composite when both asin and isbn are missing', () => {
    expect(importListItemKey({ title: 'My Book', author: 'Auth' })).toBe('My Book-Auth');
  });

  it('produces the same key regardless of array position', () => {
    const item = { title: 'Same', author: 'Same' };
    expect(importListItemKey(item)).toBe('Same-Same');
  });
});

describe('deduplicateKeys', () => {
  it('returns keys unchanged when all are unique', () => {
    expect(deduplicateKeys(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('appends dup suffix only to duplicate occurrences', () => {
    expect(deduplicateKeys(['a', 'a', 'b', 'a'])).toEqual(['a', 'a-dup1', 'b', 'a-dup2']);
  });

  it('handles all duplicates', () => {
    expect(deduplicateKeys(['x', 'x'])).toEqual(['x', 'x-dup1']);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateKeys([])).toEqual([]);
  });
});
