import { describe, it, expect } from 'vitest';
import {
  buildTitleShape,
  titlesMatchForDedup,
  matchesLibraryIdentity,
  type DedupIdentity,
  type TitleShape,
} from './dedup.js';

/** Assert a symmetric match/non-match: `titlesMatchForDedup` in BOTH directions. */
function bothWays(a: TitleShape, b: TitleShape, expected: boolean): void {
  expect(titlesMatchForDedup(a, b)).toBe(expected);
  expect(titlesMatchForDedup(b, a)).toBe(expected);
}

describe('normalizeTitleCore (via buildTitleShape.fullNormalized)', () => {
  const full = (t: string) => buildTitleShape(t).fullNormalized;

  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(full('  The   Way  Of Kings ')).toBe('the way of kings');
  });

  it('retains a colon subtitle in fullNormalized (only colonBase drops it)', () => {
    expect(full('Tehanu: The Last Book of Earthsea')).toBe('tehanu: the last book of earthsea');
  });

  it('strips a trailing parenthetical series/edition group (single-suffix parity)', () => {
    expect(full('The Farthest Shore (The Earthsea Cycle Book 3)')).toBe('the farthest shore');
  });

  it('strips a trailing `, Book N` series marker (single-suffix parity)', () => {
    expect(full('Shattered Sea, Book 1')).toBe('shattered sea');
  });

  it('strips a trailing `, Vol N` / ` Volume N` series marker (single-suffix parity)', () => {
    expect(full('Saga, Vol 2')).toBe('saga');
    expect(full('Berserk Volume 5')).toBe('berserk');
  });

  it('unwinds STACKED trailing suffixes to a fixpoint (2, 3+ parens; marker chains)', () => {
    // A fixed-two-passes impl leaves `foo (a)` on the 3-deep case; a marker-applied-once
    // impl leaves `foo, book 1` — both must fully unwind to `foo`.
    expect(full('Foo (A) (B)')).toBe('foo');
    expect(full('Foo (A) (B) (C)')).toBe('foo');
    expect(full('Foo, Book 1, Vol 2')).toBe('foo');
    // A parenthetical hidden behind a marker (paren then marker, then paren again).
    expect(full('Dune (Edition: Deluxe), Book 1')).toBe('dune');
    expect(full('Dune (Edition: Deluxe) (Unabridged)')).toBe('dune');
  });

  it('is idempotent on already-clean titles', () => {
    expect(full('the way of kings')).toBe('the way of kings');
    expect(full(full('Foo (A) (B)'))).toBe('foo');
  });
});

describe('buildTitleShape', () => {
  it('fires a colon boundary iff the trimmed prefix is ≥3 chars (internal spaces count)', () => {
    expect(buildTitleShape('The Martian: A Novel')).toEqual({
      fullNormalized: 'the martian: a novel', colonBase: 'the martian', hadSubtitle: true,
    });
    // trimmed prefix "a b" has length 3 → boundary fires.
    expect(buildTitleShape('A B: C')).toEqual({
      fullNormalized: 'a b: c', colonBase: 'a b', hadSubtitle: true,
    });
  });

  it('does NOT fire a colon boundary for a 1–2 char trimmed prefix', () => {
    expect(buildTitleShape('X: Y')).toEqual({ fullNormalized: 'x: y', colonBase: 'x: y', hadSubtitle: false });
    expect(buildTitleShape('IT: Chapter Two')).toEqual({
      fullNormalized: 'it: chapter two', colonBase: 'it: chapter two', hadSubtitle: false,
    });
  });

  it('does NOT fire when the colon is at position 0', () => {
    expect(buildTitleShape(': leading colon')).toEqual({
      fullNormalized: ': leading colon', colonBase: ': leading colon', hadSubtitle: false,
    });
  });

  it('collapses a colon that survives only inside a removable trailing suffix (F18/F22 family)', () => {
    // The fixpoint core strips the parenthetical BEFORE colon logic, so the colon never
    // becomes a false subtitle boundary — all three reduce to the bare base `dune`.
    for (const t of ['Dune (Edition: Deluxe)', 'Dune (Edition: Deluxe), Book 1', 'Dune (Edition: Deluxe) (Unabridged)']) {
      expect(buildTitleShape(t)).toEqual({ fullNormalized: 'dune', colonBase: 'dune', hadSubtitle: false });
    }
  });

  it('produces the documented mixed colon+suffix shapes', () => {
    // Book 1 is not trailing (a colon follows it), so it survives fullNormalized;
    // colonBase re-normalizes the prefix, where `, Book 1` IS trailing and strips.
    expect(buildTitleShape('Saga, Book 1: Deluxe')).toEqual({
      fullNormalized: 'saga, book 1: deluxe', colonBase: 'saga', hadSubtitle: true,
    });
    expect(buildTitleShape('Dune (Edition): Deluxe')).toEqual({
      fullNormalized: 'dune (edition): deluxe', colonBase: 'dune', hadSubtitle: true,
    });
  });
});

describe('titlesMatchForDedup', () => {
  it('bridges a bare base to one subtitled sibling (one side stripped)', () => {
    bothWays(buildTitleShape('The Martian: A Novel'), buildTitleShape('The Martian'), true);
  });

  it('does NOT match two DISTINCT subtitles (both sides stripped)', () => {
    bothWays(
      buildTitleShape('World of Warcraft: Beyond the Dark Portal'),
      buildTitleShape('World of Warcraft: Tides of Darkness'),
      false,
    );
  });

  it('matches two copies of the SAME full subtitle via the fullNormalized arm (both hadSubtitle)', () => {
    const a = buildTitleShape('World of Warcraft: Beyond the Dark Portal');
    const b = buildTitleShape('  world of WARCRAFT:  Beyond the Dark Portal (Unabridged) ');
    expect(a.hadSubtitle).toBe(true);
    expect(b.hadSubtitle).toBe(true);
    bothWays(a, b, true);
  });

  it('is non-transitive: base bridges to each sibling, siblings do not bridge each other', () => {
    const base = buildTitleShape('Series');
    const a = buildTitleShape('Series: A');
    const b = buildTitleShape('Series: B');
    bothWays(base, a, true);
    bothWays(base, b, true);
    bothWays(a, b, false);
  });

  it('collapses removable-suffix colon families to the bare base (retrieval-invariant)', () => {
    const bare = buildTitleShape('Dune');
    const shapes = [
      buildTitleShape('Dune (Edition: Deluxe)'),
      buildTitleShape('Dune (Edition: Deluxe), Book 1'),
      buildTitleShape('Dune (Edition: Deluxe) (Unabridged)'),
    ];
    for (const s of shapes) bothWays(bare, s, true);
    // ...and each other (all share colonBase "dune", none hadSubtitle).
    bothWays(shapes[0]!, shapes[1]!, true);
    bothWays(shapes[1]!, shapes[2]!, true);
  });

  it('matches stacked-paren collapses against their shallower forms', () => {
    bothWays(buildTitleShape('Foo (A) (B)'), buildTitleShape('Foo (A)'), true);
    bothWays(buildTitleShape('Foo (A) (B)'), buildTitleShape('Foo'), true);
  });

  it('mixed colon+suffix: matches the bare colonBase one-sided, not a distinct sibling', () => {
    bothWays(buildTitleShape('Saga, Book 1: Deluxe'), buildTitleShape('Saga'), true);
    bothWays(buildTitleShape('Saga, Book 1: Deluxe'), buildTitleShape('Saga: Annotated'), false);
  });

  it('a short-prefix colon title does NOT bridge to a same-base sibling', () => {
    // "X: Y" has hadSubtitle:false and colonBase "x: y" (not "x"), so it never bridges "X: A".
    bothWays(buildTitleShape('X: Y'), buildTitleShape('X: A'), false);
  });

  it('matches colon-free titles differing only in case/whitespace/single suffix (full-arm parity)', () => {
    bothWays(buildTitleShape('The Way of Kings'), buildTitleShape('  the   WAY of kings '), true);
    bothWays(buildTitleShape('Shattered Sea'), buildTitleShape('Shattered Sea, Book 1'), true);
    bothWays(buildTitleShape('The Farthest Shore'), buildTitleShape('The Farthest Shore (The Earthsea Cycle Book 3)'), true);
  });

  // #1896 — CANARY: volume-marker dedup collision (the analogue of #1891's colon
  // inversion). `normalizeTitleCore` strips a trailing `Book N` / `Vol N` marker
  // (TAG_TITLE_SERIES_MARKER_REGEX), so distinct volumes of one series both collapse to
  // the bare series name and MATCH. This behavior is KNOWN, PINNED, and DELIBERATELY
  // UNCHANGED: no live same-author `<Series> <marker> 1` vs `<marker> 2` false-positive
  // specimen has been observed, and the standing normalization-semantics decision forbids
  // changing the strip without one. If a future normalization change makes `Book 1` and
  // `Book 2` distinct, these assertions flip — pair any such change with a live specimen
  // and this issue (see #1896).
  //
  // The full shape is pinned to show the mechanism: both titles reduce to `saga`. The
  // early return is on the `fullNormalized`-equality arm (dedup.ts:118), but because these
  // no-colon shapes set `colonBase === fullNormalized` and `hadSubtitle === false`, the
  // `colonBase` fallback (dedup.ts:119) is ALSO satisfied — the match is not observably
  // "via one arm", so we assert shapes + symmetric result only, never branch exclusivity.
  it('CANARY #1896: same-series `Book 1`/`Book 2` collapse to the bare series and match', () => {
    const collapsed = { fullNormalized: 'saga', colonBase: 'saga', hadSubtitle: false };
    expect(buildTitleShape('Saga Book 1')).toEqual(collapsed);
    expect(buildTitleShape('Saga Book 2')).toEqual(collapsed);
    bothWays(buildTitleShape('Saga Book 1'), buildTitleShape('Saga Book 2'), true);
  });

  // #1896 — CANARY: cover the comma- and space-prefixed marker forms so a future regex
  // narrowing to only one form (or dropping `Vol`) trips the canary rather than silently
  // changing behavior. Each still collapses to the bare series `saga`.
  it('CANARY #1896: comma/space marker forms (`Saga, Book 1`, `Saga Vol 1`) also collapse', () => {
    const full = (t: string) => buildTitleShape(t).fullNormalized;
    expect(full('Saga, Book 1')).toBe('saga');
    expect(full('Saga Vol 1')).toBe('saga');
  });
});

describe('matchesLibraryIdentity', () => {
  const owned: DedupIdentity = { title: 'Tehanu', asin: 'B01G9EPERE', authorSlug: 'ursula-k-le-guin' };

  it('matches by ASIN case-insensitively', () => {
    expect(matchesLibraryIdentity({ title: 'Different', asin: 'b01g9epere' }, owned)).toBe(true);
  });

  // #1726 — the ASIN arm is canonicalized (trim + UPPERCASE via the shared
  // `canonicalizeAsin`) so all three homes share one ASIN contract. A padded/case-
  // drifted candidate folds to the stored canonical form and still matches.
  it('matches a whitespace-padded, case-drifted ASIN via canonicalizeAsin (#1726)', () => {
    expect(matchesLibraryIdentity({ title: 'Different', asin: '  b01g9epere  ' }, owned)).toBe(true);
  });

  it('folds a whitespace-only ASIN to "no ASIN" and falls through to the title/author ladder (#1726)', () => {
    // The blank ASIN must not match on the ASIN arm; the title/author ladder decides.
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: a subtitle', asin: '   ', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true); // falls through → title+author match
    expect(matchesLibraryIdentity(
      { title: 'Brand New Book', asin: '   ', authorName: 'New Author' },
      owned,
    )).toBe(false); // falls through → no title/author match, blank ASIN never matched
  });

  it('ASIN takes precedence over title/author', () => {
    expect(matchesLibraryIdentity(
      { title: 'Completely Other', asin: 'B01G9EPERE', authorName: 'Someone Else' },
      owned,
    )).toBe(true);
  });

  it('falls back to normalized title + author slug on an ASIN miss (different edition)', () => {
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: The Last Book of Earthsea', asin: 'B0DIFFEDIT', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true);
  });

  it('matches on colon/parenthetical/case drift ONLY when the author slug matches', () => {
    expect(matchesLibraryIdentity(
      { title: 'TEHANU: a subtitle', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true);
  });

  it('does NOT match a title-drift hit when the author slug differs', () => {
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: a subtitle', authorName: 'Some Other Author' },
      owned,
    )).toBe(false);
  });

  it('author-less title-only matches exactly and does NOT subtitle-strip', () => {
    const authorless: DedupIdentity = { title: 'Tehanu', asin: null, authorSlug: null };
    expect(matchesLibraryIdentity({ title: 'Tehanu', asin: null }, authorless)).toBe(true);
    expect(matchesLibraryIdentity({ title: 'Tehanu: X', asin: null }, authorless)).toBe(false);
  });

  it('does not match when one side is authored and the other author-less', () => {
    const authorless: DedupIdentity = { title: 'Tehanu', asin: null, authorSlug: null };
    expect(matchesLibraryIdentity({ title: 'Tehanu', authorName: 'Ursula K. Le Guin' }, authorless)).toBe(false);
  });

  it('returns false for a genuinely new book', () => {
    expect(matchesLibraryIdentity({ title: 'Brand New Book', authorName: 'New Author' }, owned)).toBe(false);
  });

  it('bridges a bare base to a subtitled sibling under an equal author slug (#1891)', () => {
    const martian: DedupIdentity = { title: 'The Martian', asin: null, authorSlug: 'andy-weir' };
    expect(matchesLibraryIdentity(
      { title: 'The Martian: A Novel', asin: null, authorName: 'Andy Weir' },
      martian,
    )).toBe(true);
  });

  it('does NOT match two distinct-subtitle franchise titles under an equal author slug (#1891 WoW)', () => {
    const owned1: DedupIdentity = { title: 'World of Warcraft: Tides of Darkness', asin: null, authorSlug: 'aaron-rosenberg' };
    expect(matchesLibraryIdentity(
      { title: 'World of Warcraft: Beyond the Dark Portal', asin: null, authorName: 'Aaron Rosenberg' },
      owned1,
    )).toBe(false);
  });

  it('matches a removable-suffix colon family against the bare base under an equal author slug (#1891)', () => {
    const dune: DedupIdentity = { title: 'Dune', asin: null, authorSlug: 'frank-herbert' };
    for (const title of ['Dune (Edition: Deluxe)', 'Dune (Edition: Deluxe), Book 1']) {
      expect(matchesLibraryIdentity({ title, asin: null, authorName: 'Frank Herbert' }, dune)).toBe(true);
    }
  });

  // #1896 — CANARY: the volume-marker collision at the identity level. `Saga Book 1` and
  // `Saga Book 2` collapse to `saga` (see the titlesMatchForDedup canary above), so a
  // SAME-AUTHOR pair matches via identity arm (2). KNOWN, PINNED, DELIBERATELY UNCHANGED
  // pending a live specimen (standing normalization-semantics decision). The blast radius
  // is bounded by the position-0 author-slug gate: a CROSS-AUTHOR pair does NOT match, so
  // the collapse can never merge two different authors' books.
  it('CANARY #1896: same-author `Book 1`/`Book 2` match; cross-author does NOT (author-slug gate)', () => {
    expect(matchesLibraryIdentity(
      { title: 'Saga Book 2', authorName: 'A B' },
      { title: 'Saga Book 1', authorName: 'A B' },
    )).toBe(true);
    expect(matchesLibraryIdentity(
      { title: 'Saga Book 2', authorName: 'C D' },
      { title: 'Saga Book 1', authorName: 'A B' },
    )).toBe(false);
  });
});
