import { describe, it, expect } from 'vitest';
import { MAM_TORRENT_SENTINEL_PREFIX } from './mam-wedge.js';
import { ABB_DETAILS_SENTINEL_PREFIX, abbDetailsSentinel, parseAbbDetailsUrl } from './abb-sentinel.js';

describe('abb-sentinel', () => {
  describe('round-trip', () => {
    const detailsUrls = [
      'https://audiobookbay.test/audio-books/plain-slug/',
      'https://audiobookbay.test/audio-books/slug/?utm=1&other=two',
      'https://audiobookbay.test/audio-books/a%20b%2Fc/',
      'https://audiobookbay.test/audio-books/mörder-im-wald-日本語/',
      'https://audiobookbay.test/audio-books/slug/?q=a+b%26c#frag',
    ];

    for (const detailsUrl of detailsUrls) {
      it(`carries ${detailsUrl} through the sentinel byte-for-byte`, () => {
        expect(parseAbbDetailsUrl(abbDetailsSentinel(detailsUrl))).toBe(detailsUrl);
      });
    }

    it('prefixes rather than rewrites, so the sentinel is the prefix plus the URL verbatim', () => {
      const detailsUrl = 'https://audiobookbay.test/audio-books/slug/?q=a%20b';

      expect(abbDetailsSentinel(detailsUrl)).toBe(`${ABB_DETAILS_SENTINEL_PREFIX}${detailsUrl}`);
    });
  });

  describe('rejection', () => {
    // Each of these reaches `resolveDownloadUrl` in production, and every one must pass through
    // untouched rather than be mistaken for a details URL.
    const notSentinels: Array<[string, string]> = [
      ['a bare magnet URI', 'magnet:?xt=urn:btih:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
      ['a MAM sentinel', `${MAM_TORRENT_SENTINEL_PREFIX}12345`],
      ['an empty string', ''],
      ['the bare prefix with no URL after it', ABB_DETAILS_SENTINEL_PREFIX],
      ['the prefix followed by whitespace only', `${ABB_DETAILS_SENTINEL_PREFIX}   `],
      ['a details URL with no prefix', 'https://audiobookbay.test/audio-books/slug/'],
      ['the prefix somewhere other than the start', `https://x.test/?u=${ABB_DETAILS_SENTINEL_PREFIX}y`],
      ['a near-miss scheme', 'abb-detail://https://audiobookbay.test/audio-books/slug/'],
    ];

    for (const [label, value] of notSentinels) {
      it(`reads ${label} as not a sentinel`, () => {
        expect(parseAbbDetailsUrl(value)).toBeUndefined();
      });
    }
  });

  it('uses a scheme distinct from MAM\'s, so neither adapter can claim the other\'s sentinel', () => {
    expect(ABB_DETAILS_SENTINEL_PREFIX).toBe('abb-details://');
    expect(parseAbbDetailsUrl(`${MAM_TORRENT_SENTINEL_PREFIX}1`)).toBeUndefined();
  });
});
