import { describe, it, expect } from 'vitest';
import { abbGuid, isAbbRootUrl, rewriteAbbUrl } from './abb-url.js';

const BASE = 'https://abb.test';

/** Every case below drives production's own composition, so a hand-written string cannot drift. */
function rewrite(href: string, base = BASE): string {
  const rewritten = rewriteAbbUrl(href, base);
  if (rewritten === undefined) throw new Error(`expected ${href} to rewrite against ${base}`);
  return rewritten;
}

describe('rewriteAbbUrl', () => {
  describe('composes the resolved path onto the configured origin', () => {
    const cases: Array<[label: string, href: string, expected: string]> = [
      ['a root-relative href', '/audio-books/x/', `${BASE}/audio-books/x/`],
      ['a document-relative href', 'audio-books/x/', `${BASE}/audio-books/x/`],
      // The row this issue exists for: raw markup disagreeing on scheme, www AND host case.
      ['an absolute href on another scheme, host and case', 'HTTP://WWW.ABB.TEST/Audio-Books/X/?a=1#z', `${BASE}/Audio-Books/X/?a=1#z`],
      ['an absolute href on a different host', 'https://other.test/audio-books/x/', `${BASE}/audio-books/x/`],
      ['a www alias of the configured host', 'https://www.abb.test/audio-books/x/', `${BASE}/audio-books/x/`],
      // `startsWith('http')` read this as absolute; it is a relative path.
      ['a relative path that merely starts with "http"', 'httpfoo', `${BASE}/httpfoo`],
      // ...and this as relative; it is protocol-relative and resolves off-host.
      ['a protocol-relative href', '//other.test/x', `${BASE}/x`],
      ['a colon-leading href, which resolves as a path and not a scheme', '://x', `${BASE}/://x`],
      ['a path carrying a query', '/audio-books/x/?utm=1&other=two', `${BASE}/audio-books/x/?utm=1&other=two`],
      ['a path carrying a fragment', '/audio-books/x/#part-2', `${BASE}/audio-books/x/#part-2`],
      ['a percent-encoded path', '/audio-books/a%20b%2Fc/', `${BASE}/audio-books/a%20b%2Fc/`],
    ];

    for (const [label, href, expected] of cases) {
      it(`rewrites ${label}`, () => {
        expect(rewriteAbbUrl(href, BASE)).toBe(expected);
      });
    }
  });

  /**
   * Host case folds because the URL parser lowercases it; path case must NOT, because ABB serves
   * paths case-significantly and folding them would merge two genuinely different releases.
   */
  it('folds host case but preserves path case', () => {
    expect(rewriteAbbUrl('HTTPS://ABB.TEST/Audio-Books/X/', BASE)).toBe(`${BASE}/Audio-Books/X/`);
    expect(rewriteAbbUrl('/Audio-Books/X/', BASE)).not.toBe(rewriteAbbUrl('/audio-books/x/', BASE));
  });

  it('puts an explicit port from the configured base onto the output origin', () => {
    expect(rewriteAbbUrl('https://other.test/audio-books/x/', 'https://abb.test:8080'))
      .toBe('https://abb.test:8080/audio-books/x/');
  });

  it('is idempotent: rewriting an already-rewritten URL returns it unchanged', () => {
    for (const href of ['/audio-books/x/?q=1#frag', 'https://other.test/y/', '//www.other.test/z']) {
      const once = rewrite(href);
      expect(rewrite(once)).toBe(once);
    }
  });

  /**
   * Arm B — the input resolves, but to a scheme that is not http(s). Today's `startsWith('http')`
   * branch hands these straight through, so a `javascript:` href becomes a guid, a sentinel and
   * eventually an argument to `fetchPage`.
   */
  describe('Arm B — a resolvable non-http(s) scheme', () => {
    for (const href of ['javascript:alert(1)', 'mailto:a@b', 'data:text/html,x']) {
      it(`returns undefined for ${href}`, () => {
        expect(rewriteAbbUrl(href, BASE)).toBeUndefined();
      });
    }
  });

  /**
   * Arm A — a separate branch from Arm B, and the reason it gets its own block: these fail inside
   * the `URL` constructor and never reach the scheme guard, so an implementation with no try/catch
   * passes every Arm B case above and throws out of the row loop here.
   */
  describe('Arm A — an input the URL constructor rejects', () => {
    for (const href of ['http://[::1', 'http://a b', 'http://', '//']) {
      it(`returns undefined for ${JSON.stringify(href)} without throwing`, () => {
        expect(() => rewriteAbbUrl(href, BASE)).not.toThrow();
        expect(rewriteAbbUrl(href, BASE)).toBeUndefined();
      });
    }

    it('returns undefined rather than throwing when the base itself is unparseable', () => {
      expect(() => rewriteAbbUrl('/audio-books/x/', 'not a url')).not.toThrow();
      expect(rewriteAbbUrl('/audio-books/x/', 'not a url')).toBeUndefined();
    });
  });
});

describe('isAbbRootUrl', () => {
  /**
   * Driven through `rewriteAbbUrl` exactly as production does — asserting on hand-written root
   * strings would prove the predicate alone and not that the two compose.
   */
  describe('true for every href that collapses onto the bare site root', () => {
    const collapsing = [
      '   ',
      '#',
      '#fragment',
      '/',
      '/#frag',
      '/.',
      '?',
      '/?',
      'https://other.test/#/audio-books/x',
    ];

    for (const href of collapsing) {
      it(`rejects ${JSON.stringify(href)}`, () => {
        expect(isAbbRootUrl(rewrite(href))).toBe(true);
      });
    }
  });

  /**
   * The load-bearing half. ABB's markup is WordPress-shaped, so a mirror on default permalinks
   * genuinely serves posts at `/?p=N`: a predicate narrowed to `pathname === '/'` passes every
   * rejection case above while silently making such a mirror unusable.
   */
  describe('false for a URL that addresses a real page', () => {
    for (const href of ['/?p=12345', '?s=x', '/audio-books/x/', '%20']) {
      it(`keeps ${JSON.stringify(href)}`, () => {
        expect(isAbbRootUrl(rewrite(href))).toBe(false);
      });
    }
  });

  // `abbGuid` drops the fragment, so a fragment that rescued a root URL would give two rows one guid.
  it('is not rescued by a fragment', () => {
    expect(isAbbRootUrl(rewrite('#a'))).toBe(true);
    expect(isAbbRootUrl(rewrite('#b'))).toBe(true);
    expect(abbGuid(rewrite('#a'))).toBe(abbGuid(rewrite('#b')));
  });
});

describe('abbGuid', () => {
  it('collapses scheme, host, www and port onto one identity', () => {
    const canonical = abbGuid(rewrite('/audio-books/x/'));
    const aliases = [
      rewrite('http://abb.test/audio-books/x/'),
      rewrite('https://www.abb.test/audio-books/x/'),
      rewrite('https://other.test/audio-books/x/'),
      rewrite('/audio-books/x/', 'https://abb.test:8080'),
      rewrite('/audio-books/x/', 'https://mirror-b.test'),
    ];

    for (const alias of aliases) {
      expect(abbGuid(alias)).toBe(canonical);
    }
    expect(canonical).toBe('abb:/audio-books/x/');
  });

  it('separates two releases differing only in path or query', () => {
    expect(abbGuid(rewrite('/audio-books/x/'))).not.toBe(abbGuid(rewrite('/audio-books/y/')));
    expect(abbGuid(rewrite('/?p=1'))).not.toBe(abbGuid(rewrite('/?p=2')));
  });

  it('keeps the query and drops the fragment', () => {
    expect(abbGuid(rewrite('/audio-books/x/?utm=1&other=two#frag'))).toBe('abb:/audio-books/x/?utm=1&other=two');
  });

  // The counterfactual for an implementation that lowercases: the server treats these as two pages.
  it('preserves path case', () => {
    expect(abbGuid(rewrite('/Audio-Books/X/'))).toBe('abb:/Audio-Books/X/');
    expect(abbGuid(rewrite('/Audio-Books/X/'))).not.toBe(abbGuid(rewrite('/audio-books/x/')));
  });

  /**
   * `blacklist.guid` is unique across every indexer, so a bare `/audio-books/x/` could collide with
   * another indexer's guid; and a host segment is exactly what a mirror hop changes.
   */
  it('is namespaced and carries no host segment', () => {
    for (const href of ['/audio-books/x/', 'https://other.test/y/?q=1', '%20']) {
      const guid = abbGuid(rewrite(href));
      expect(guid.startsWith('abb:')).toBe(true);
      expect(guid).not.toContain('//');
      expect(guid).not.toContain('abb.test');
    }
  });
});
