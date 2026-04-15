import { describe, it, expect } from 'vitest';
import { sanitizeLogUrl } from './sanitize-log-url.js';

describe('sanitizeLogUrl', () => {
  describe('HTTP/HTTPS URLs', () => {
    it('strips query params from HTTP URL with apikey', () => {
      expect(sanitizeLogUrl('http://indexer.example.com/download.nzb?apikey=SECRET123'))
        .toBe('http://indexer.example.com/download.nzb');
    });

    it('strips all query params from URL with multiple params', () => {
      expect(sanitizeLogUrl('https://api.indexer.com/api?key=SECRET&other=val&t=get'))
        .toBe('https://api.indexer.com/api');
    });

    it('returns URL unchanged when no query params present', () => {
      expect(sanitizeLogUrl('https://indexer.example.com/download/12345'))
        .toBe('https://indexer.example.com/download/12345');
    });

    it('strips hash fragment from URL', () => {
      expect(sanitizeLogUrl('https://example.com/path#fragment'))
        .toBe('https://example.com/path');
    });

    it('handles HTTPS URLs the same as HTTP', () => {
      expect(sanitizeLogUrl('https://secure.indexer.com/nzb?apikey=SECRET'))
        .toBe('https://secure.indexer.com/nzb');
    });
  });

  describe('data URIs', () => {
    it('returns resolved placeholder for data:application/x-bittorrent URIs', () => {
      const dataUri = 'data:application/x-bittorrent;base64,AAAA';
      expect(sanitizeLogUrl(dataUri))
        .toBe('data:application/x-bittorrent [resolved]');
    });
  });

  describe('magnet URIs', () => {
    it('returns magnet:[infoHash] for magnet URI with xt param', () => {
      expect(sanitizeLogUrl('magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12&dn=Test&tr=udp://tracker.example.com'))
        .toBe('magnet:[abcdef1234567890abcdef1234567890abcdef12]');
    });

    it('returns magnet:[unknown] for magnet URI without info hash', () => {
      expect(sanitizeLogUrl('magnet:?dn=Test&tr=udp://tracker.example.com'))
        .toBe('magnet:[unknown]');
    });

    it('handles encoded-colon (%3A) in magnet URI with hex hash', () => {
      expect(sanitizeLogUrl('magnet:?xt=urn%3Abtih%3Aabcdef1234567890abcdef1234567890abcdef12&dn=Test&tr=udp://tracker.example.com'))
        .toBe('magnet:[abcdef1234567890abcdef1234567890abcdef12]');
    });

    it('handles encoded-colon (%3A) in magnet URI with base32 hash', () => {
      expect(sanitizeLogUrl('magnet:?xt=urn%3Abtih%3AJBSWY3DPEHPK3PXPIRSWMZLOOMQGCZZA'))
        .toBe('magnet:[jbswy3dpehpk3pxpirswmzloomqgczza]');
    });
  });

  describe('edge cases', () => {
    it('handles empty string gracefully', () => {
      expect(sanitizeLogUrl('')).toBe('');
    });

    it('handles malformed URL gracefully', () => {
      const result = sanitizeLogUrl('not-a-url');
      expect(result).toBe('not-a-url');
    });
  });
});
