import { describe, it, expect } from 'vitest';
import { parseHardcoverListUrl } from './hardcover-list-url.js';

describe('parseHardcoverListUrl (#1879 AC2)', () => {
  const expected = { username: 'LisaRae', slug: '2025-year-in-books' };

  describe('valid forms', () => {
    it('parses the canonical https URL', () => {
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae/lists/2025-year-in-books')).toEqual(expected);
    });

    it('parses a trailing-slash URL', () => {
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae/lists/2025-year-in-books/')).toEqual(expected);
    });

    it('parses an http:// URL', () => {
      expect(parseHardcoverListUrl('http://hardcover.app/@LisaRae/lists/2025-year-in-books')).toEqual(expected);
    });

    it('parses a bare-host URL (no scheme)', () => {
      expect(parseHardcoverListUrl('hardcover.app/@LisaRae/lists/2025-year-in-books')).toEqual(expected);
    });

    it('tolerates a missing @ on the username', () => {
      expect(parseHardcoverListUrl('https://hardcover.app/LisaRae/lists/2025-year-in-books')).toEqual(expected);
    });

    it('tolerates a www. host and a trailing query/hash', () => {
      expect(parseHardcoverListUrl('https://www.hardcover.app/@LisaRae/lists/2025-year-in-books?ref=x')).toEqual(expected);
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae/lists/2025-year-in-books#top')).toEqual(expected);
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(parseHardcoverListUrl('  https://hardcover.app/@LisaRae/lists/2025-year-in-books  ')).toEqual(expected);
    });
  });

  describe('invalid forms → null', () => {
    it('rejects a non-Hardcover host', () => {
      expect(parseHardcoverListUrl('https://goodreads.com/@LisaRae/lists/2025-year-in-books')).toBeNull();
    });

    it('rejects a profile URL without /lists/', () => {
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae')).toBeNull();
    });

    it('rejects a list URL missing the slug', () => {
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae/lists/')).toBeNull();
      expect(parseHardcoverListUrl('https://hardcover.app/@LisaRae/lists')).toBeNull();
    });

    it('rejects a bare slug', () => {
      expect(parseHardcoverListUrl('2025-year-in-books')).toBeNull();
    });

    it('rejects empty and whitespace-only input', () => {
      expect(parseHardcoverListUrl('')).toBeNull();
      expect(parseHardcoverListUrl('   ')).toBeNull();
    });
  });
});
