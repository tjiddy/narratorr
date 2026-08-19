import { describe, it, expect } from 'vitest';
import { servesFullList } from './qb-hash-filter.js';

/**
 * #2485 AC7e — the one place the empty-filter semantics are ASSERTED rather than merely used.
 * Every qBittorrent list double routes its `hashes` decision through `servesFullList`, so this
 * fence is what stops the absent / empty / pipe-only / non-matching distinction silently
 * reverting to a `params.has('hashes')` truthiness gate at any of those sites.
 */
describe('servesFullList (#2485)', () => {
  const HEX = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
  const OTHER_HEX = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';

  function paramsOf(query: string) {
    return new URL(`http://qb.test/api/v2/torrents/info${query}`).searchParams;
  }

  it.each([
    ['an absent hashes param', ''],
    ['an empty hashes value', '?hashes='],
    ['a pipe-only hashes value', '?hashes=||'],
  ])('serves the full list for %s', (_label, query) => {
    expect(servesFullList(paramsOf(query))).toBe(true);
  });

  it.each([
    ['a single hash', `?hashes=${HEX}`],
    ['a pipe-joined hash list', `?hashes=${HEX}|${OTHER_HEX}`],
    // SkipEmptyParts drops only genuinely EMPTY parts, so three decoded spaces survive as a part
    // and therefore are a real filter (torrentscontroller.cpp:608-625).
    ['percent-encoded whitespace', '?hashes=%20%20%20'],
    // URLSearchParams form-decodes '+' to a space, so this is the same surviving-part case.
    ['plus-encoded whitespace', '?hashes=+++'],
  ])('treats %s as a real filter', (_label, query) => {
    expect(servesFullList(paramsOf(query))).toBe(false);
  });

  /**
   * The limit of this fence: the WHATWG URL parser strips raw literal trailing whitespace before
   * `searchParams` ever sees it, so `?hashes=   ` in final position collapses to the `?hashes=`
   * row above and is not separately observable here. That is documented parser behavior, not a
   * predicate defect — blank-input production behavior is pinned by request COUNT instead.
   */
  it('cannot distinguish raw trailing whitespace from an empty value', () => {
    const params = paramsOf('?hashes=   ');
    expect(params.get('hashes')).toBe('');
    expect(servesFullList(params)).toBe(true);
  });

  it('ignores other params when classifying the hashes axis', () => {
    expect(servesFullList(paramsOf('?category=audiobooks'))).toBe(true);
    expect(servesFullList(paramsOf(`?category=audiobooks&hashes=${HEX}`))).toBe(false);
  });
});
