import { describe, it, expect } from 'vitest';
import {
  buildQueryLadder,
  passesSegmentFloor,
  selectRelaxedCandidate,
  rungDedupKey,
  MAX_SEARCH_RUNGS,
  type Rung,
} from './search-query-ladder.js';
import { buildSearchQuery } from './indexer-query.js';
import { titleSegments, normalizeTitleForVariantMatch } from '@core/utils/title-variants.js';
import type { SearchResult } from '@core/index.js';

/** Compact `tag@author` view of a ladder, for order assertions. */
function shape(ladder: Rung[]): string[] {
  return ladder.map((r) => `${r.variant?.tag ?? 'canonical'}@${r.author ?? '-'}`);
}

/** Find the single admitted rung carrying `tag` (author-ON pass). */
function rungFor(ladder: Rung[], tag: string): Rung {
  const found = ladder.find((r) => r.variant?.tag === tag);
  if (!found) throw new Error(`no admitted rung tagged ${tag} in ${JSON.stringify(shape(ladder))}`);
  return found;
}

/**
 * Overrides that may carry an explicit `undefined` to STRIP a default field —
 * `Partial<T>` rejects that under `exactOptionalPropertyTypes`. Same mapped-type
 * shape as `MakeResultOverrides` in `search-pipeline.test.ts`.
 */
type MakeResultOverrides = { [K in keyof SearchResult]?: SearchResult[K] | undefined } & { title: string };

const RESULT_DEFAULTS = { protocol: 'usenet', indexer: 'Test', downloadUrl: 'https://x/1' } as const;

function makeResult(overrides: MakeResultOverrides): SearchResult {
  return { ...RESULT_DEFAULTS, ...overrides } as SearchResult;
}

/**
 * #2133 AC9 — the titles the anchored floor rule is specified over: the three
 * live examples, the depth/punctuation shapes #2104 already pinned, and the
 * three derived classes of AC16 (collapsed anchors, an anchor recurring inside a
 * neighbouring segment, a generic parenthetical splitting an anchor). `Dune`
 * carries the fewer-than-two-effective-segments arm.
 */
const FLOOR_FIXTURES = [
  'Star Wars: The High Republic: Haunted Starlight',
  'The Churn: An Expanse Novella',
  'Star Wars: The Rising Storm (The High Republic)',
  'Alpha: Beta: Gamma: Delta: Eps: Zeta',
  'Star Wars: ---: The High Republic: Haunted Starlight',
  'Star Wars: The High Republic: Star Wars',
  'Alpha: Beta Gamma: Gamma',
  'Star (Deluxe) Wars: Haunted Starlight',
  'Dune',
] as const;

/** Text no fixture title contains, for the AC9(b) generated siblings. */
const UNRELATED = 'Quixotic Zephyr Nonesuch';

/**
 * Rebuild a release name from `title` with the effective segment at one END
 * replaced by unrelated text (#2133 AC9(b)).
 *
 * Operates on the RAW segments and rejoins on `:`, so every other segment
 * survives verbatim and a punctuation-only segment stays where it was — the
 * replaced index is the first/last segment that is non-empty after
 * normalization, which is the anchor's own position.
 */
function replaceEndSegment(title: string, end: 'first' | 'last'): string {
  const raw = titleSegments(title);
  const effective = raw.flatMap((s, i) => (normalizeTitleForVariantMatch(s).length > 0 ? [i] : []));
  const target = end === 'first' ? effective[0] : effective[effective.length - 1];
  return raw.map((segment, i) => (i === target ? ` ${UNRELATED} ` : segment)).join(':');
}

/** Every admitted segment-cut rung of `title`, deduped by tag. */
function segmentCutRungs(title: string): Rung[] {
  const byTag = new Map<string, Rung>();
  for (const rung of buildQueryLadder({ title, author: 'A' })) {
    const tag = rung.variant?.tag;
    if (tag === undefined || tag === 'full') continue;
    if (!byTag.has(tag)) byTag.set(tag, rung);
  }
  return [...byTag.values()];
}

describe('buildQueryLadder', () => {
  // AC1 — rung 1 is today's canonical query verbatim, so a book findable at
  // rung 1 issues byte-identically the same query it did before the ladder.
  it('opens with the canonical query, byte-identical to buildSearchQuery (AC1)', () => {
    const book = { title: 'Star Wars: The High Republic: Haunted Starlight', authors: [{ name: 'George Mann' }] };
    const ladder = buildQueryLadder({ title: book.title, author: book.authors[0]!.name });

    expect(ladder[0]).toEqual({
      query: buildSearchQuery(book),
      author: 'George Mann',
      variant: null,
      segments: [],
      floorSegments: [],
    });
    expect(ladder[0]!.query).toBe('Star Wars The High Republic Haunted Starlight George Mann');
  });

  // AC1, AC2, AC3, AC4 — the deep-franchise live example, asserted as a full
  // ordered array. The generator's order is a TOTAL order (#2096 G4), so this
  // pins membership, author-major ordering, admission, and each rung's floor.
  //
  // #2138 THE DISPLACEMENT, stated here rather than discovered later: the bare
  // distinguishing-title rung `suffix(1)` is now admitted (index 4), and
  // `MAX_SEARCH_RUNGS` stays 8 — so it does not lengthen the ladder, it
  // DISPLACES the deepest author-OFF rung. `first+last@-` (this array's former
  // index 7) is no longer issued at all. Exhaustion still means "all 8 rungs
  // returned an answered zero", so the 24h cooldown semantics are unchanged.
  it('emits the full author-major ladder for the deep-franchise live example (AC1-AC4)', () => {
    const ladder = buildQueryLadder({
      title: 'Star Wars: The High Republic: Haunted Starlight',
      author: 'George Mann',
    });

    // #2133 AC1, AC3 — every segment-cut rung carries the SAME anchored floor
    // (the canonical first and last effective segments), whatever it transported;
    // `segments` still records what it transported.
    const FLOOR = ['star wars', 'haunted starlight'];
    expect(ladder).toEqual([
      {
        query: 'Star Wars The High Republic Haunted Starlight George Mann',
        author: 'George Mann',
        variant: null,
        segments: [],
        floorSegments: [],
      },
      {
        query: 'star wars the high republic George Mann',
        author: 'George Mann',
        variant: { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
        segments: ['star wars', 'the high republic'],
        floorSegments: FLOOR,
      },
      {
        query: 'the high republic haunted starlight George Mann',
        author: 'George Mann',
        variant: { raw: 'the high republic haunted starlight', tag: 'suffix(2)', parensStripped: true, lossy: false },
        segments: ['the high republic', 'haunted starlight'],
        floorSegments: FLOOR,
      },
      {
        query: 'star wars haunted starlight George Mann',
        author: 'George Mann',
        variant: { raw: 'star wars haunted starlight', tag: 'first+last', parensStripped: true, lossy: false },
        segments: ['star wars', 'haunted starlight'],
        floorSegments: FLOOR,
      },
      // #2138 AC1 — the bare distinguishing title, the deepest rung of the
      // author-ON arm. It carries the SAME shared floor as every other cut, so
      // #2133's anchored corroboration applies to it byte-identically.
      {
        query: 'haunted starlight George Mann',
        author: 'George Mann',
        variant: { raw: 'haunted starlight', tag: 'suffix(1)', parensStripped: true, lossy: false },
        segments: ['haunted starlight'],
        floorSegments: FLOOR,
      },
      {
        query: 'star wars the high republic haunted starlight',
        author: undefined,
        variant: { raw: 'star wars the high republic haunted starlight', tag: 'full', parensStripped: false, lossy: false },
        segments: [],
        floorSegments: [],
      },
      {
        query: 'star wars the high republic',
        author: undefined,
        variant: { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
        segments: ['star wars', 'the high republic'],
        floorSegments: FLOOR,
      },
      {
        query: 'the high republic haunted starlight',
        author: undefined,
        variant: { raw: 'the high republic haunted starlight', tag: 'suffix(2)', parensStripped: true, lossy: false },
        segments: ['the high republic', 'haunted starlight'],
        floorSegments: FLOOR,
      },
    ]);

    // AC3 — `prefix(1)` = "star wars" retains 1 against a budget of ceil(3/2) = 2
    // and is NOT exempt: the pure-franchise rung the budget exists to suppress
    // stays suppressed, on both author arms.
    expect(shape(ladder)).not.toContain('prefix(1)@George Mann');
    expect(shape(ladder)).not.toContain('prefix(1)@-');
    expect(ladder.every((r) => r.query !== 'star wars' && r.query !== 'star wars George Mann')).toBe(true);
  });

  // #2138 AC2 — the cap absorbs the growth. Asserted separately from the array
  // above so the length claim has its own observation point.
  it('does not lengthen the deep-franchise ladder past the cap (AC2)', () => {
    const ladder = buildQueryLadder({
      title: 'Star Wars: The High Republic: Haunted Starlight',
      author: 'George Mann',
    });
    expect(MAX_SEARCH_RUNGS).toBe(8);
    expect(ladder).toHaveLength(MAX_SEARCH_RUNGS);
    // The displaced rung: today's deepest author-OFF cut is gone.
    expect(shape(ladder)).not.toContain('first+last@-');
  });

  // #2138 F2 (spec review) — the tail exemption is admission policy, not author
  // policy. Existing no-author coverage uses the two-segment Churn shape where
  // `suffix(1)` was already admitted, so it cannot see an implementation that
  // accidentally gates the new exemption on author presence.
  it('admits the tail rung on a deep title with no author, in one deduped arm (AC1, F2)', () => {
    const ladder = buildQueryLadder({ title: 'Star Wars: The High Republic: Haunted Starlight' });

    expect(shape(ladder)).toEqual([
      'canonical@-',
      'prefix(2)@-',
      'suffix(2)@-',
      'first+last@-',
      'suffix(1)@-',
    ]);
    expect(ladder.every((r) => r.author === undefined)).toBe(true);
    expect(rungFor(ladder, 'suffix(1)').query).toBe('haunted starlight');
    expect(rungFor(ladder, 'suffix(1)').segments).toEqual(['haunted starlight']);
    expect(shape(ladder)).not.toContain('prefix(1)@-');
  });

  // #2138 AC6 — shallow and colon-free titles are untouched. `suffix(1)` was
  // ALREADY admitted at two effective segments (budget 1), which is how "The
  // Churn" works, so these shapes must be byte-identical to today's.
  it.each([
    [
      'The Churn: An Expanse Novella',
      'James S. A. Corey',
      ['canonical@James S. A. Corey', 'prefix(1)@James S. A. Corey', 'suffix(1)@James S. A. Corey', 'full@-', 'prefix(1)@-', 'suffix(1)@-'],
    ],
    ['Dune', 'Frank Herbert', ['canonical@Frank Herbert', 'full@-']],
  ])('leaves the %s ladder unchanged (AC6)', (title, author, expected) => {
    expect(shape(buildQueryLadder({ title, author }))).toEqual(expected);
  });

  // #2138 AC4 — the exemption is keyed on the TAG, not on "the slice equals the
  // last effective segment". Here the two readings diverge: the generator's
  // first-wins dedup hands the tail TEXT to `prefix(1)`, so no `suffix(1)` is
  // emitted at all and this ladder is byte-identical to today's.
  //
  // COUNTERFACTUAL: exempt any slice equal to the last effective segment and the
  // bare pure-franchise query `star wars` is admitted here.
  it('never admits the tail text when dedup hands it to prefix(1) (AC4)', () => {
    const ladder = buildQueryLadder({ title: 'Star Wars: The High Republic: Star Wars', author: 'George Mann' });

    expect(shape(ladder)).toEqual([
      'canonical@George Mann',
      'prefix(2)@George Mann',
      'suffix(2)@George Mann',
      'first+last@George Mann',
      'full@-',
      'prefix(2)@-',
      'suffix(2)@-',
      'first+last@-',
    ]);
    expect(ladder.every((r) => r.variant?.tag !== 'suffix(1)')).toBe(true);
    expect(ladder.every((r) => r.variant?.raw !== 'star wars')).toBe(true);
  });

  // #2138 AC4 — the other divergence: a LEADING `---` makes dedup hand the tail
  // text `gamma` to `first+last`, whose slice contains the normalization-empty
  // segment, so step 1 still rejects it. Neither a `first+last` nor any tail
  // rung is issued; the ladder is unchanged.
  it('issues no tail rung when dedup hands the tail text to a step-1-rejected first+last (AC4)', () => {
    const ladder = buildQueryLadder({ title: '---: Alpha: Beta: Gamma', author: 'A' });

    expect(shape(ladder)).toEqual(['canonical@A', 'suffix(2)@A', 'full@-', 'suffix(2)@-']);
    expect(ladder.every((r) => r.variant?.tag !== 'first+last')).toBe(true);
    expect(ladder.every((r) => r.variant?.tag !== 'suffix(1)')).toBe(true);
    expect(ladder.every((r) => r.variant?.raw !== 'gamma')).toBe(true);
  });

  // #2138 AC7 — the depth boundary is a CONSEQUENCE of the cap, measured here,
  // not ordering logic. 3, 4 and 5 effective segments reach the tail rung; at
  // 6 the author-ON arm fills the cap before it.
  it.each([
    ['Alpha: Beta: Gamma', 'suffix(1)@A'],
    ['Alpha: Beta: Gamma: Delta', 'suffix(1)@A'],
    ['Alpha: Beta: Gamma: Delta: Eps', 'suffix(1)@A'],
  ])('reaches the tail rung on %s (AC7)', (title, expected) => {
    expect(shape(buildQueryLadder({ title, author: 'A' }))).toContain(expected);
  });

  it('does not reach the tail rung at six effective segments — the cap fills first (AC7)', () => {
    const ladder = buildQueryLadder({ title: 'Alpha: Beta: Gamma: Delta: Eps: Zeta', author: 'Author Name' });

    // Byte-identical to today: the whole cap is the author-ON arm, ending at
    // `first+last`, so the tail rung is never emitted.
    expect(shape(ladder)).toEqual([
      'canonical@Author Name',
      'prefix(5)@Author Name',
      'suffix(5)@Author Name',
      'prefix(4)@Author Name',
      'suffix(4)@Author Name',
      'prefix(3)@Author Name',
      'suffix(3)@Author Name',
      'first+last@Author Name',
    ]);
    expect(ladder).toHaveLength(MAX_SEARCH_RUNGS);
  });

  // D3 step 1 + D7 — the floor tests exactly the constraints the budget granted.
  it('keeps segments.join(" ") exactly equal to variant.raw on every admitted rung', () => {
    const titles = [
      'Star Wars: The High Republic: Haunted Starlight',
      'The Churn: An Expanse Novella',
      'Star Wars: The Rising Storm (The High Republic)',
      'Alpha: Beta: Gamma: Delta: Eps: Zeta',
    ];
    for (const title of titles) {
      for (const rung of buildQueryLadder({ title, author: 'A' })) {
        if (!rung.variant || rung.variant.tag === 'full') {
          expect(rung.segments).toEqual([]);
          continue;
        }
        expect(rung.segments.join(' ')).toBe(rung.variant.raw);
        for (const segment of rung.segments) expect(segment).not.toBe('');
      }
    }
  });

  // #2133 AC3 — the worked floor values. Each is built over the DISTINCT anchor
  // values, each repeated as many times as it occurs in the canonical title's
  // own effective text.
  it.each([
    ['Star Wars: The High Republic: Haunted Starlight', ['star wars', 'haunted starlight']],
    ['The Churn: An Expanse Novella', ['the churn', 'an expanse novella']],
    ['Star Wars: The Rising Storm (The High Republic)', ['star wars', 'the rising storm']],
    ['Alpha: Beta: Gamma: Delta: Eps: Zeta', ['alpha', 'zeta']],
    // A punctuation-only edge segment never becomes an empty anchor.
    ['Star Wars: ---: The High Republic: Haunted Starlight', ['star wars', 'haunted starlight']],
    // COUNTERFACTUAL: build the array POSITIONALLY (a count per position rather
    // than per distinct value) and this emits FOUR copies, which makes the
    // book's own title fail its own floor.
    ['Star Wars: The High Republic: Star Wars', ['star wars', 'star wars']],
    // The anchor `gamma` recurs inside the neighbouring segment, so the
    // canonical text demands it twice.
    ['Alpha: Beta Gamma: Gamma', ['alpha', 'gamma', 'gamma']],
    // A generic parenthetical splits the first anchor; both sides reduce through
    // `titleSegments`, so the anchor is the paren-stripped `star wars`.
    ['Star (Deluxe) Wars: Haunted Starlight', ['star wars', 'haunted starlight']],
  ])('floors every segment-cut rung of %s at the canonical anchors (AC3)', (title, expected) => {
    const cuts = segmentCutRungs(title);
    expect(cuts.length).toBeGreaterThan(0);
    for (const rung of cuts) expect(rung.floorSegments).toEqual(expected);
  });

  // #2133 AC4 — fewer than two effective segments admits no segment cut at all,
  // so no rung of such a title carries a floor.
  it('carries an empty floor on every rung of a title with fewer than two effective segments (AC4)', () => {
    const ladder = buildQueryLadder({ title: 'Dune', author: 'Frank Herbert' });
    expect(segmentCutRungs('Dune')).toEqual([]);
    expect(ladder.every((r) => r.floorSegments.length === 0)).toBe(true);
  });

  // #2133 AC9(a) — the construction invariant, over the whole fixture list.
  it('carries an empty floor exactly on rung 1 and full rungs, and one identical floor on every cut (AC9a)', () => {
    for (const title of FLOOR_FIXTURES) {
      const ladder = buildQueryLadder({ title, author: 'A' });
      const cutFloors = new Set<string>();
      for (const rung of ladder) {
        const unfloored = rung.variant === null || rung.variant.tag === 'full';
        expect({ title, tag: rung.variant?.tag ?? 'canonical', empty: rung.floorSegments.length === 0 })
          .toEqual({ title, tag: rung.variant?.tag ?? 'canonical', empty: unfloored });
        if (unfloored) continue;
        for (const segment of rung.floorSegments) expect(segment).not.toBe('');
        cutFloors.add(JSON.stringify(rung.floorSegments));
      }
      // Byte-identical across every segment-cut rung of the same title.
      expect(cutFloors.size).toBeLessThanOrEqual(1);
    }
  });

  // AC42 — the separating test for the whole raw-vs-normalized decision.
  it('never admits a slice containing a punctuation-only segment (AC42, D3 step 1)', () => {
    const title = 'Star Wars: ---: The High Republic: Haunted Starlight';
    const ladder = buildQueryLadder({ title, author: 'George Mann' });

    // COUNTERFACTUAL: count RAW segments instead of normalized ones and
    // `prefix(2)` (raw = "star wars") satisfies ceil(4/2) = 2, entering with the
    // single-element floor ["star wars"] — the pure-franchise rung.
    expect(shape(ladder)).not.toContain('prefix(2)@George Mann');
    expect(ladder.every((r) => r.segments.length !== 1 || r.segments[0] !== 'star wars')).toBe(true);

    const firstLast = rungFor(ladder, 'first+last');
    expect(firstLast.segments).toEqual(['star wars', 'haunted starlight']);
    expect(passesSegmentFloor('Star Wars: Cataclysm', firstLast)).toBe(false);
    expect(passesSegmentFloor('Star Wars: Haunted Starlight', firstLast)).toBe(true);

    // #2138 AC5 — step 1 binds the tail rung too, and it binds BEFORE the
    // exemption is consulted. Here the retained tail segment is non-empty, so
    // the rung IS admitted and carries the same shared floor; the interior `---`
    // still keeps every pure-franchise slice out.
    const tail = rungFor(ladder, 'suffix(1)');
    expect(tail.query).toBe('haunted starlight George Mann');
    expect(tail.segments).toEqual(['haunted starlight']);
    expect(tail.floorSegments).toEqual(['star wars', 'haunted starlight']);
    expect(passesSegmentFloor('Star Wars: Cataclysm', tail)).toBe(false);
    expect(passesSegmentFloor('Star Wars: Haunted Starlight', tail)).toBe(true);
  });

  // #2138 AC5 — a TRAILING punctuation-only segment admits no cut rung at all,
  // so the exemption has nothing to widen. Measured, not predicted: the
  // generator's `suffix(1)` here would retain the empty `---`, so its `raw`
  // normalizes to '' and the generator never emits it — step 1 stays ahead of
  // the exemption as the structural invariant, but for this tag the upstream
  // empty-`raw` guard is what the rejection actually reduces to. Every OTHER cut
  // (`suffix(2)`, `first+last`) retains the empty segment and step 1 rejects it.
  it('admits no cut rung, and no garbage floor, for a trailing punctuation-only segment (AC5)', () => {
    const ladder = buildQueryLadder({ title: 'Alpha: Beta: ---', author: 'A' });

    expect(shape(ladder)).toEqual(['canonical@A', 'full@-']);
    expect(ladder.every((r) => r.floorSegments.length === 0)).toBe(true);
    for (const rung of ladder) for (const segment of rung.segments) expect(segment).not.toBe('');
  });

  // AC3 — the budget denominator must be the effective segment count, not
  // anything inferred from the emitted tags.
  it('divides the EFFECTIVE segment count, admitting suffix(2) where tag inference would not (AC3)', () => {
    const ladder = buildQueryLadder({ title: '---: Beta: Gamma: Delta: Eps', author: 'A' });

    // segmentCount is 4 (beta/gamma/delta/eps) → budget 2, so `suffix(2)` =
    // "delta eps" is legitimate. COUNTERFACTUAL: derive the denominator from
    // `max(emitted n) + 1` and it yields 5 → budget 3 → this rung disappears.
    const suffix2 = rungFor(ladder, 'suffix(2)');
    expect(suffix2.segments).toEqual(['delta', 'eps']);
    expect(suffix2.variant?.raw).toBe('delta eps');
  });

  // AC43 — `first+last` is exempt from the COUNT budget, never from step 1.
  it('rejects first+last when its retained slice contains a normalization-empty segment (AC43)', () => {
    const ladder = buildQueryLadder({ title: '---: Alpha: Beta: Gamma', author: 'A' });

    // COUNTERFACTUAL: apply step 1 only to prefix/suffix and `first+last`
    // (raw = "gamma", retaining the empty `---` plus `gamma`) returns with a
    // one-element floor.
    expect(shape(ladder)).not.toContain('first+last@A');
    expect(ladder.every((r) => r.variant?.tag !== 'first+last')).toBe(true);
  });

  // AC5 — the normalized dedup key is what collapses rung 1 onto the
  // generator's `full` variant despite case and the `&` → "and" fold.
  it('collapses the generator full onto rung 1 on the normalized key, first occurrence winning (AC5)', () => {
    const ladder = buildQueryLadder({ title: 'Foo & Bar', author: 'Author' });

    // Rung 1 keeps the literal `&` (cleanIndexerQuery does not touch it) while
    // the variant folds it to "and" — same key, so only rung 1 survives.
    expect(ladder[0]!.query).toBe('Foo & Bar Author');
    expect(rungDedupKey(ladder[0]!)).toBe('foo and bar author|1');
    expect(shape(ladder)).toEqual(['canonical@Author', 'full@-']);
    expect(ladder[1]!.query).toBe('foo and bar');
  });

  // AC6 — a colon-free, paren-free title collapses to at most one extra rung.
  it('yields exactly two rungs and no segment rung for a colon-free, paren-free title (AC6)', () => {
    const ladder = buildQueryLadder({ title: 'Dune', author: 'Frank Herbert' });

    expect(shape(ladder)).toEqual(['canonical@Frank Herbert', 'full@-']);
    expect(ladder.every((r) => r.segments.length === 0)).toBe(true);
  });

  // AC7 — with no author every rung already carries `author: undefined`, so the
  // author-OFF pass is entirely absorbed by dedup.
  it('emits no author-OFF duplicates when the book has no author (AC7)', () => {
    const ladder = buildQueryLadder({ title: 'The Churn: An Expanse Novella' });

    expect(shape(ladder)).toEqual(['canonical@-', 'prefix(1)@-', 'suffix(1)@-']);
    expect(ladder.every((r) => r.author === undefined)).toBe(true);
  });

  // AC13 — the live examples reach their winning rung at the documented depth.
  it.each([
    ['The Churn: An Expanse Novella', 'James S. A. Corey', 1, 'prefix(1)', 'the churn James S A Corey'],
    ['Star Wars: The Rising Storm (The High Republic)', 'Cavan Scott', 1, 'full', 'star wars the rising storm Cavan Scott'],
    ['Star Wars: The High Republic: Haunted Starlight', 'George Mann', 3, 'first+last', 'star wars haunted starlight George Mann'],
  ])('places the %s winning rung at index %#', (title, author, index, tag, query) => {
    const ladder = buildQueryLadder({ title, author });
    expect(ladder[index]!.variant?.tag).toBe(tag);
    expect(ladder[index]!.query).toBe(query);
    expect(ladder[index]!.author).toBe(author);
  });

  // AC8 — a title whose distinguishing content the ASCII fold erases would
  // relax to a franchise-wide query on every rung.
  it.each([
    ['World of Warcraft: Перед бурей'],
    ['World of Warcraft: A前夜'],
  ])('runs rung 1 only for the degenerate title %s (AC8)', (title) => {
    const ladder = buildQueryLadder({ title, author: 'Christie Golden' });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.variant).toBeNull();
  });

  // AC9 — a title-only-unusable book with a usable author still searches
  // author-only, exactly as it did before the ladder.
  it('runs rung 1 only when every variant normalizes away, preserving the author-only search (AC9)', () => {
    const ladder = buildQueryLadder({ title: '???', author: 'Frank Herbert' });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.query).toBe('Frank Herbert');
  });

  // AC4 — the cap is the only protection against MAM's server-side rate limit.
  it('never exceeds MAX_SEARCH_RUNGS (AC4)', () => {
    const ladder = buildQueryLadder({
      title: 'Alpha: Beta: Gamma: Delta: Eps: Zeta',
      author: 'Author Name',
    });
    expect(MAX_SEARCH_RUNGS).toBe(8);
    expect(ladder).toHaveLength(MAX_SEARCH_RUNGS);
  });
});

describe('the anchored floor — sibling rejection (#2133)', () => {
  // AC9(b) — the universal this issue exists to establish. All three releases
  // are GENERATED from each fixture title, so adding a title extends the
  // property automatically. The hold arms are provable: replacing an end segment
  // removes one occurrence of that anchor, so the release necessarily falls
  // below the count the canonical text demands.
  it.each(FLOOR_FIXTURES.filter((title) => segmentCutRungs(title).length > 0))(
    'grabs %s verbatim and holds both end-replaced siblings on every cut rung (AC9b)',
    (title) => {
      const lastReplaced = replaceEndSegment(title, 'last');
      const firstReplaced = replaceEndSegment(title, 'first');
      for (const rung of segmentCutRungs(title)) {
        const tag = rung.variant!.tag;
        expect({ tag, release: 'verbatim', passes: passesSegmentFloor(title, rung) })
          .toEqual({ tag, release: 'verbatim', passes: true });
        expect({ tag, release: lastReplaced, passes: passesSegmentFloor(lastReplaced, rung) })
          .toEqual({ tag, release: lastReplaced, passes: false });
        expect({ tag, release: firstReplaced, passes: passesSegmentFloor(firstReplaced, rung) })
          .toEqual({ tag, release: firstReplaced, passes: false });
      }
    },
  );

  // AC9(c) — self-pass is a RECORDED TABLE, not a rule. Two review rounds killed
  // two different prose characterizations of this set; it is an artifact of the
  // generator and the anchor counts, so do not restate it as a rule. A `true`
  // row is not a defect — those rungs transport exactly the anchor text, and the
  // floor still adds CONTIGUITY, which a token-AND indexer does not guarantee.
  it('records the measured self-pass verdict for every admitted cut rung (AC9c)', () => {
    const measured: Record<string, boolean> = {};
    for (const title of FLOOR_FIXTURES) {
      for (const rung of segmentCutRungs(title)) {
        measured[`${title} | ${rung.variant!.tag}`] = passesSegmentFloor(rung.variant!.raw, rung);
      }
    }

    expect(measured).toEqual({
      'Star Wars: The High Republic: Haunted Starlight | prefix(2)': false,
      'Star Wars: The High Republic: Haunted Starlight | suffix(2)': false,
      'Star Wars: The High Republic: Haunted Starlight | first+last': true,
      // #2138 — the tail rung. It transports ONLY the last anchor, so the shared
      // floor's first anchor is unsatisfied and the rung does not self-pass: a
      // franchise-dropping release found here is held, not grabbed (AC10).
      'Star Wars: The High Republic: Haunted Starlight | suffix(1)': false,
      'The Churn: An Expanse Novella | prefix(1)': false,
      'The Churn: An Expanse Novella | suffix(1)': false,
      'Star Wars: The Rising Storm (The High Republic) | prefix(1)': false,
      'Star Wars: The Rising Storm (The High Republic) | suffix(1)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | prefix(5)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | suffix(5)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | prefix(4)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | suffix(4)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | prefix(3)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | suffix(3)': false,
      'Alpha: Beta: Gamma: Delta: Eps: Zeta | first+last': true,
      'Star Wars: ---: The High Republic: Haunted Starlight | first+last': true,
      'Star Wars: ---: The High Republic: Haunted Starlight | suffix(1)': false,
      'Star Wars: The High Republic: Star Wars | prefix(2)': false,
      'Star Wars: The High Republic: Star Wars | suffix(2)': false,
      'Star Wars: The High Republic: Star Wars | first+last': true,
      'Alpha: Beta Gamma: Gamma | prefix(2)': false,
      'Alpha: Beta Gamma: Gamma | suffix(2)': false,
      'Alpha: Beta Gamma: Gamma | first+last': false,
      // The canonical text demands `gamma` twice; the tail rung supplies one.
      'Alpha: Beta Gamma: Gamma | suffix(1)': false,
      'Star (Deluxe) Wars: Haunted Starlight | prefix(1)': false,
      'Star (Deluxe) Wars: Haunted Starlight | suffix(1)': false,
    });
  });
});

describe('passesSegmentFloor', () => {
  const haunted = buildQueryLadder({ title: 'Star Wars: The High Republic: Haunted Starlight', author: 'George Mann' });
  const firstLast = rungFor(haunted, 'first+last');
  const prefix2 = rungFor(haunted, 'prefix(2)');
  const churn = buildQueryLadder({ title: 'The Churn: An Expanse Novella', author: 'James S. A. Corey' });
  const prefix1 = rungFor(churn, 'prefix(1)');
  const churnSuffix1 = rungFor(churn, 'suffix(1)');
  const risingStorm = buildQueryLadder({ title: 'Star Wars: The Rising Storm (The High Republic)', author: 'Cavan Scott' });
  const risingStormPrefix1 = rungFor(risingStorm, 'prefix(1)');
  // #2133 AC16 — the three derived classes.
  const collapsedPrefix2 = rungFor(buildQueryLadder({ title: 'Star Wars: The High Republic: Star Wars', author: 'George Mann' }), 'prefix(2)');
  const neighbourPrefix2 = rungFor(buildQueryLadder({ title: 'Alpha: Beta Gamma: Gamma', author: 'A' }), 'prefix(2)');
  const parenPrefix1 = rungFor(buildQueryLadder({ title: 'Star (Deluxe) Wars: Haunted Starlight', author: 'George Mann' }), 'prefix(1)');
  // F1 — a canonical title that is itself pure ASCII (so it is NOT caught by the
  // rung-1-only degenerate short-circuit) and whose anchors are short enough to
  // be supplied by a lossy release's surviving characters.
  const wowPrefix1 = rungFor(buildQueryLadder({ title: 'World of Warcraft: A', author: 'Christie Golden' }), 'prefix(1)');

  // AC10 — a `full` rung is not a segment cut, so there is nothing to corroborate.
  it('short-circuits true for a full-tagged rung without inspecting the title (AC10, #2133 AC2)', () => {
    const full = rungFor(risingStorm, 'full');
    expect(full.segments).toEqual([]);
    expect(full.floorSegments).toEqual([]);
    expect(passesSegmentFloor('Something Entirely Unrelated', full)).toBe(true);
  });

  it('short-circuits true for rung 1, which is never floored', () => {
    expect(haunted[0]!.floorSegments).toEqual([]);
    expect(passesSegmentFloor('Something Entirely Unrelated', haunted[0]!)).toBe(true);
  });

  // AC11, AC12 — the ground-truth verdicts plus the two load-bearing
  // counterfactual rows.
  it.each([
    // AC11 reference verdicts. The `firstLast` rows are unchanged by #2133 —
    // that rung's floor VALUE is the same array it always carried.
    ['Star Wars: Haunted Starlight', firstLast, true],
    ['Star Wars: The High Republic: Cataclysm', firstLast, false],
    ['The Expanse: Nemesis Games', prefix1, false],
    // AC12 — the book's own canonical title must never false-negative.
    // COUNTERFACTUAL: whole-`raw` string containment flips ONLY this row to false.
    ['Star Wars: The High Republic: Haunted Starlight', firstLast, true],
    // AC12 — contiguity. COUNTERFACTUAL: a non-contiguous ordered token walk
    // flips ONLY this row to true.
    ['Star Wars: Haunted Totally Different Starlight', firstLast, false],
    // AC12 — space-bounded. "the churner" must not satisfy "the churn".
    ['The Churner', prefix1, false],

    // #2133 AC5 — the live repro. The prefix(2) rung transports exactly
    // `["star wars", "the high republic"]`, so under the pre-#2133 retained-set
    // floor EVERY High Republic sibling corroborated its own query.
    // COUNTERFACTUAL: read `rung.segments` instead of `rung.floorSegments` and
    // both sibling rows flip to true.
    ['01 Star Wars-The High Republic-The Eye of Darkness', prefix2, false],
    ['Star Wars: The High Republic: Cataclysm', prefix2, false],
    ['Star Wars: Haunted Starlight', prefix2, true],
    ['Star Wars: The High Republic: Haunted Starlight', prefix2, true],

    // #2133 AC7 — the suffix-side mirror hole, and the accepted flip: a release
    // named by the canonical HEAD alone is corroborated only by the query's own
    // tokens, which is the circular evidence this issue outlaws.
    ['The Vital Abyss: An Expanse Novella', churnSuffix1, false],
    ['Gods of Risk: An Expanse Novella', churnSuffix1, false],
    ['The Churn', prefix1, false],
    ['The Churn (Unabridged) [M4B]', prefix1, false],
    ['The Churn: An Expanse Novella', prefix1, true],
    ['The Churn: An Expanse Novella', churnSuffix1, true],

    // #2133 AC8 — a two-segment franchise title already shipped a single-segment
    // franchise floor; that rung's own `variant.raw` no longer satisfies it.
    ['Star Wars: Cataclysm', risingStormPrefix1, false],
    ['Star Wars: The Rising Storm', risingStormPrefix1, true],
    ['Star Wars: The Rising Storm (The High Republic)', risingStormPrefix1, true],

    // #2133 AC15, AC16 — collapsed anchors. The floor demands `star wars` TWICE
    // because the canonical title carries it twice, and the prefix(2) query only
    // guarantees one. COUNTERFACTUAL: demand each distinct anchor once and the
    // sibling row flips to true; restart the occurrence scan past the shared
    // delimiter and the own-title and noisy rows flip to false.
    ['Star Wars: The High Republic: The Eye of Darkness', collapsedPrefix2, false],
    ['Star Wars: Cataclysm', collapsedPrefix2, false],
    ['Star Wars: The High Republic: Star Wars', collapsedPrefix2, true],
    ['01 Star Wars-The High Republic-Star Wars', collapsedPrefix2, true],

    // #2133 AC16 — an anchor recurring inside a NEIGHBOURING segment. The rung's
    // own text supplies one `gamma`; the canonical title demands two.
    ['Alpha: Beta Gamma: Delta', neighbourPrefix2, false],
    ['Alpha: Beta Gamma: Gamma', neighbourPrefix2, true],
    // The accepted second-order hold: indistinguishable from a sibling that
    // borrowed `gamma` from the middle segment.
    ['Alpha: Gamma', neighbourPrefix2, false],

    // #2133 AC0, AC16 — a generic parenthetical splitting an anchor. Both sides
    // reduce through `titleSegments`. COUNTERFACTUAL: reduce the release with
    // `normalizeTitleForVariantMatch` alone and the book's OWN paren-intact
    // release fails its own floor.
    ['Star (Deluxe) Wars: Haunted Starlight', parenPrefix1, true],
    // The accepted hold: a different book naming the wanted one only in an aside.
    ['Cataclysm (Star Wars: Haunted Starlight)', parenPrefix1, false],

    // F1 — the OFFERED side of the character-survival gate. The floor's anchors
    // are ASCII by construction, so a release whose distinguishing characters
    // the fold erases can supply them from what SURVIVED and masquerade as the
    // wanted book. `"A前夜"` and `"A後夜"` are different books that both reduce
    // to the anchor `a` — the mixed-token collision `degenerate-full-form-under-
    // lossy-fold` names, one layer down from #2103.
    // COUNTERFACTUAL: drop the `hasDegenerateFullForm` guard and both flip true.
    ['World of Warcraft: A前夜', wowPrefix1, false],
    ['World of Warcraft: A後夜', wowPrefix1, false],
    // The gate runs on the RAW release title, matching the canonical side's own
    // `hasDegenerateFullForm` call — so lossy content inside a stripped
    // parenthetical still refuses, even though the floor's axis would drop it.
    ['World of Warcraft: A (Перед бурей)', wowPrefix1, false],
    // …and it costs the book nothing: its own ASCII release still grabs.
    ['World of Warcraft: A', wowPrefix1, true],
  ])('verdict for %s', (releaseTitle, rung, expected) => {
    expect(passesSegmentFloor(releaseTitle, rung)).toBe(expected);
  });
});

describe('selectRelaxedCandidate', () => {
  const haunted = buildQueryLadder({ title: 'Star Wars: The High Republic: Haunted Starlight', author: 'George Mann' });
  const cut = rungFor(haunted, 'first+last');
  const full = rungFor(buildQueryLadder({ title: 'Star Wars: The Rising Storm (The High Republic)', author: 'Cavan Scott' }), 'full');

  const passing = (title = 'Star Wars: Haunted Starlight') => makeResult({ title });
  const failing = (title = 'Star Wars: The High Republic: Cataclysm') => makeResult({ title });
  const undownloadable = (title: string) => makeResult({ title, downloadUrl: undefined });

  // AC33 — a `full` rung never applies the floor and never holds.
  it('grabs the top result on a full rung without applying the floor (AC33)', () => {
    expect(selectRelaxedCandidate([failing(), passing()], full)).toEqual({ kind: 'grab', result: failing() });
  });

  it('returns none on a full rung with an empty eligible population (AC33, AC40)', () => {
    expect(selectRelaxedCandidate([], full)).toEqual({ kind: 'none' });
  });

  // AC40 — an empty post-gate list is not a floor rejection.
  it('returns none with no held event for an empty post-gate list (AC40)', () => {
    expect(selectRelaxedCandidate([], cut)).toEqual({ kind: 'none' });
  });

  // AC40, AC41 — the eligible population is the DOWNLOADABLE subset.
  // COUNTERFACTUAL: define it as the whole ranked list and this returns `hold`.
  it('returns none when nothing is downloadable, even though results FAIL the floor (AC40)', () => {
    expect(selectRelaxedCandidate([undownloadable('The Expanse: Nemesis Games')], cut)).toEqual({ kind: 'none' });
  });

  it('returns none when floor-PASSING results exist but none is downloadable (AC40)', () => {
    expect(selectRelaxedCandidate([undownloadable('Star Wars: Haunted Starlight')], cut)).toEqual({ kind: 'none' });
  });

  // AC31 — a lower-ranked passing candidate is grabbed, no held event.
  it('grabs the highest-ranked PASSING downloadable candidate past a failing one (AC31)', () => {
    const results = [failing(), passing('Star Wars: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({ kind: 'grab', result: results[1] });
  });

  // AC41 — a non-downloadable result never suppresses a lower-ranked grab.
  it('ignores a non-downloadable passing result when ranking the eligible population (AC41)', () => {
    const results = [undownloadable('Star Wars: Haunted Starlight'), passing('Star Wars: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({ kind: 'grab', result: results[1] });
  });

  // AC14, AC41 — the held event names the top DOWNLOADABLE candidate, which by
  // construction failed; a higher-ranked non-downloadable pass is never named.
  it('holds naming the top downloadable candidate when a non-downloadable one passed (AC14, AC41)', () => {
    const results = [undownloadable('Star Wars: Haunted Starlight'), failing('Star Wars: The High Republic: Cataclysm')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({
      kind: 'hold',
      releaseTitle: 'Star Wars: The High Republic: Cataclysm',
    });
  });

  // AC14, AC32 — exactly one hold regardless of how many candidates failed.
  it('holds once, naming the highest-ranked downloadable failure (AC14, AC32)', () => {
    const results = [failing('Star Wars: The High Republic: Cataclysm'), failing('Star Wars: Haunted Totally Different Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({
      kind: 'hold',
      releaseTitle: 'Star Wars: The High Republic: Cataclysm',
    });
  });

  // #2133 AC5, AC6 — the same two decisions on the PREFIX rung. Every case above
  // uses `first+last`, which is exactly why the circular-floor hole stayed
  // invisible: a prefix rung's retained segments ARE its query, so before #2133
  // every franchise sibling corroborated itself.
  const prefix2 = rungFor(haunted, 'prefix(2)');

  it('holds every High-Republic sibling on the prefix(2) rung, naming the top one (AC5)', () => {
    const results = [
      makeResult({ title: '01 Star Wars-The High Republic-The Eye of Darkness' }),
      makeResult({ title: 'Star Wars: The High Republic: Cataclysm' }),
    ];
    expect(selectRelaxedCandidate(results, prefix2)).toEqual({
      kind: 'hold',
      releaseTitle: '01 Star Wars-The High Republic-The Eye of Darkness',
    });
  });

  it('grabs a lower-ranked passing candidate past a failing one on the prefix(2) rung (AC6)', () => {
    const results = [failing('01 Star Wars-The High Republic-The Eye of Darkness'), passing('Star Wars: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, prefix2)).toEqual({ kind: 'grab', result: results[1] });
  });

  it("grabs the book's own canonical title on the prefix(2) rung (AC6)", () => {
    const results = [passing('Star Wars: The High Republic: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, prefix2)).toEqual({ kind: 'grab', result: results[0] });
  });
});
