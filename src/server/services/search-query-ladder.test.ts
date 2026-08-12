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

function shape(ladder: Rung[]): string[] {
  return ladder.map((r) => `${r.variant?.tag ?? 'canonical'}@${r.author ?? '-'}`);
}

function rungFor(ladder: Rung[], tag: string): Rung {
  const found = ladder.find((r) => r.variant?.tag === tag);
  if (!found) throw new Error(`no admitted rung tagged ${tag} in ${JSON.stringify(shape(ladder))}`);
  return found;
}

// Explicit `undefined` strips defaults; `Partial<T>` rejects it under `exactOptionalPropertyTypes`.
type MakeResultOverrides = { [K in keyof SearchResult]?: SearchResult[K] | undefined } & { title: string };

const RESULT_DEFAULTS = { protocol: 'usenet', indexer: 'Test', downloadUrl: 'https://x/1' } as const;

function makeResult(overrides: MakeResultOverrides): SearchResult {
  return { ...RESULT_DEFAULTS, ...overrides } as SearchResult;
}

// AC9 fixtures cover live cases, depth/punctuation, derived anchor classes, and the single-segment arm.
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

const UNRELATED = 'Quixotic Zephyr Nonesuch';

// Replace an effective end in the raw segments, preserving punctuation-only segments and all other text (#2133 AC9b).
function replaceEndSegment(title: string, end: 'first' | 'last'): string {
  const raw = titleSegments(title);
  const effective = raw.flatMap((s, i) => (normalizeTitleForVariantMatch(s).length > 0 ? [i] : []));
  const target = end === 'first' ? effective[0] : effective[effective.length - 1];
  return raw.map((segment, i) => (i === target ? ` ${UNRELATED} ` : segment)).join(':');
}

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

  // The full array pins total author-major order. At the fixed cap, new `suffix(1)` displaces `first+last@-`; exhaustion semantics stay unchanged (#2138).
  it('emits the full author-major ladder for the deep-franchise live example (AC1-AC4)', () => {
    const ladder = buildQueryLadder({
      title: 'Star Wars: The High Republic: Haunted Starlight',
      author: 'George Mann',
    });

    // Every cut carries the same canonical-end floor; `segments` records its transported slice.
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

    // `prefix(1)` retains 1 below the budget of 2 and is not tail-exempt (AC3).
    expect(shape(ladder)).not.toContain('prefix(1)@George Mann');
    expect(shape(ladder)).not.toContain('prefix(1)@-');
    expect(ladder.every((r) => r.query !== 'star wars' && r.query !== 'star wars George Mann')).toBe(true);
  });

  it('does not lengthen the deep-franchise ladder past the cap (AC2)', () => {
    const ladder = buildQueryLadder({
      title: 'Star Wars: The High Republic: Haunted Starlight',
      author: 'George Mann',
    });
    expect(MAX_SEARCH_RUNGS).toBe(8);
    expect(ladder).toHaveLength(MAX_SEARCH_RUNGS);
    expect(shape(ladder)).not.toContain('first+last@-');
  });

  // A deep no-author fixture catches accidentally gating the tail exemption on author presence (#2138 F2).
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

  // Tail exemption is tag-based: exempting equal slice text would admit the pure-franchise `star wars` query (#2138 AC4).
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

  // Leading `---` lets first-wins dedup claim the tail text for a step-1-rejected `first+last` (#2138 AC4).
  it('issues no tail rung when dedup hands the tail text to a step-1-rejected first+last (AC4)', () => {
    const ladder = buildQueryLadder({ title: '---: Alpha: Beta: Gamma', author: 'A' });

    expect(shape(ladder)).toEqual(['canonical@A', 'suffix(2)@A', 'full@-', 'suffix(2)@-']);
    expect(ladder.every((r) => r.variant?.tag !== 'first+last')).toBe(true);
    expect(ladder.every((r) => r.variant?.tag !== 'suffix(1)')).toBe(true);
    expect(ladder.every((r) => r.variant?.raw !== 'gamma')).toBe(true);
  });

  it.each([
    ['Alpha: Beta: Gamma', 'suffix(1)@A'],
    ['Alpha: Beta: Gamma: Delta', 'suffix(1)@A'],
    ['Alpha: Beta: Gamma: Delta: Eps', 'suffix(1)@A'],
  ])('reaches the tail rung on %s (AC7)', (title, expected) => {
    expect(shape(buildQueryLadder({ title, author: 'A' }))).toContain(expected);
  });

  it('does not reach the tail rung at six effective segments — the cap fills first (AC7)', () => {
    const ladder = buildQueryLadder({ title: 'Alpha: Beta: Gamma: Delta: Eps: Zeta', author: 'Author Name' });

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

  // Floors repeat each distinct anchor as many times as canonical effective text contains it (#2133 AC3).
  it.each([
    ['Star Wars: The High Republic: Haunted Starlight', ['star wars', 'haunted starlight']],
    ['The Churn: An Expanse Novella', ['the churn', 'an expanse novella']],
    ['Star Wars: The Rising Storm (The High Republic)', ['star wars', 'the rising storm']],
    ['Alpha: Beta: Gamma: Delta: Eps: Zeta', ['alpha', 'zeta']],
    ['Star Wars: ---: The High Republic: Haunted Starlight', ['star wars', 'haunted starlight']],
    // Positional counting would emit four copies and make the canonical title fail its own floor.
    ['Star Wars: The High Republic: Star Wars', ['star wars', 'star wars']],
    // `gamma` recurs inside its neighboring segment, so canonical text demands it twice.
    ['Alpha: Beta Gamma: Gamma', ['alpha', 'gamma', 'gamma']],
    // `titleSegments` strips the generic parenthetical before deriving the first anchor.
    ['Star (Deluxe) Wars: Haunted Starlight', ['star wars', 'haunted starlight']],
  ])('floors every segment-cut rung of %s at the canonical anchors (AC3)', (title, expected) => {
    const cuts = segmentCutRungs(title);
    expect(cuts.length).toBeGreaterThan(0);
    for (const rung of cuts) expect(rung.floorSegments).toEqual(expected);
  });

  it('carries an empty floor on every rung of a title with fewer than two effective segments (AC4)', () => {
    const ladder = buildQueryLadder({ title: 'Dune', author: 'Frank Herbert' });
    expect(segmentCutRungs('Dune')).toEqual([]);
    expect(ladder.every((r) => r.floorSegments.length === 0)).toBe(true);
  });

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
      expect(cutFloors.size).toBeLessThanOrEqual(1);
    }
  });

  it('never admits a slice containing a punctuation-only segment (AC42, D3 step 1)', () => {
    const title = 'Star Wars: ---: The High Republic: Haunted Starlight';
    const ladder = buildQueryLadder({ title, author: 'George Mann' });

    // Counting raw segments would admit pure-franchise `prefix(2)` with floor `["star wars"]`.
    expect(shape(ladder)).not.toContain('prefix(2)@George Mann');
    expect(ladder.every((r) => r.segments.length !== 1 || r.segments[0] !== 'star wars')).toBe(true);

    const firstLast = rungFor(ladder, 'first+last');
    expect(firstLast.segments).toEqual(['star wars', 'haunted starlight']);
    expect(passesSegmentFloor('Star Wars: Cataclysm', firstLast)).toBe(false);
    expect(passesSegmentFloor('Star Wars: Haunted Starlight', firstLast)).toBe(true);

    // Step 1 precedes tail exemption: the non-empty tail survives while interior `---` blocks pure-franchise slices (#2138 AC5).
    const tail = rungFor(ladder, 'suffix(1)');
    expect(tail.query).toBe('haunted starlight George Mann');
    expect(tail.segments).toEqual(['haunted starlight']);
    expect(tail.floorSegments).toEqual(['star wars', 'haunted starlight']);
    expect(passesSegmentFloor('Star Wars: Cataclysm', tail)).toBe(false);
    expect(passesSegmentFloor('Star Wars: Haunted Starlight', tail)).toBe(true);
  });

  // A trailing punctuation-only tail dies at the empty-raw guard; other cuts retaining it die at step 1 (#2138 AC5).
  it('admits no cut rung, and no garbage floor, for a trailing punctuation-only segment (AC5)', () => {
    const ladder = buildQueryLadder({ title: 'Alpha: Beta: ---', author: 'A' });

    expect(shape(ladder)).toEqual(['canonical@A', 'full@-']);
    expect(ladder.every((r) => r.floorSegments.length === 0)).toBe(true);
    for (const rung of ladder) for (const segment of rung.segments) expect(segment).not.toBe('');
  });

  it('divides the EFFECTIVE segment count, admitting suffix(2) where tag inference would not (AC3)', () => {
    const ladder = buildQueryLadder({ title: '---: Beta: Gamma: Delta: Eps', author: 'A' });

    // Inferring five segments from emitted tags would raise the budget to 3 and drop this valid rung.
    const suffix2 = rungFor(ladder, 'suffix(2)');
    expect(suffix2.segments).toEqual(['delta', 'eps']);
    expect(suffix2.variant?.raw).toBe('delta eps');
  });

  it('rejects first+last when its retained slice contains a normalization-empty segment (AC43)', () => {
    const ladder = buildQueryLadder({ title: '---: Alpha: Beta: Gamma', author: 'A' });

    // Applying step 1 only to prefix/suffix would admit `first+last` with a one-element floor.
    expect(shape(ladder)).not.toContain('first+last@A');
    expect(ladder.every((r) => r.variant?.tag !== 'first+last')).toBe(true);
  });

  it('collapses the generator full onto rung 1 on the normalized key, first occurrence winning (AC5)', () => {
    const ladder = buildQueryLadder({ title: 'Foo & Bar', author: 'Author' });

    // Rung 1 retains `&`, but the dedup key folds it to `and`, collapsing the generated full variant.
    expect(ladder[0]!.query).toBe('Foo & Bar Author');
    expect(rungDedupKey(ladder[0]!)).toBe('foo and bar author|1');
    expect(shape(ladder)).toEqual(['canonical@Author', 'full@-']);
    expect(ladder[1]!.query).toBe('foo and bar');
  });

  it('yields exactly two rungs and no segment rung for a colon-free, paren-free title (AC6)', () => {
    const ladder = buildQueryLadder({ title: 'Dune', author: 'Frank Herbert' });

    expect(shape(ladder)).toEqual(['canonical@Frank Herbert', 'full@-']);
    expect(ladder.every((r) => r.segments.length === 0)).toBe(true);
  });

  it('emits no author-OFF duplicates when the book has no author (AC7)', () => {
    const ladder = buildQueryLadder({ title: 'The Churn: An Expanse Novella' });

    expect(shape(ladder)).toEqual(['canonical@-', 'prefix(1)@-', 'suffix(1)@-']);
    expect(ladder.every((r) => r.author === undefined)).toBe(true);
  });

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

  it.each([
    ['World of Warcraft: Перед бурей'],
    ['World of Warcraft: A前夜'],
  ])('runs rung 1 only for the degenerate title %s (AC8)', (title) => {
    const ladder = buildQueryLadder({ title, author: 'Christie Golden' });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.variant).toBeNull();
  });

  it('runs rung 1 only when every variant normalizes away, preserving the author-only search (AC9)', () => {
    const ladder = buildQueryLadder({ title: '???', author: 'Frank Herbert' });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.query).toBe('Frank Herbert');
  });

  // The cap is the only protection against MAM's server-side rate limit (AC4).
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
  // Generated end replacements remove one demanded anchor occurrence; extending the fixture list extends the property (AC9b).
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

  // Self-pass is measured data, not a rule. True rows still add contiguity beyond a token-AND indexer (AC9c).
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
      // Tail-only transport misses the first anchor, so franchise-dropping results hold (#2138 AC10).
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
      // Canonical text demands `gamma` twice; the tail supplies one.
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
  const collapsedPrefix2 = rungFor(buildQueryLadder({ title: 'Star Wars: The High Republic: Star Wars', author: 'George Mann' }), 'prefix(2)');
  const neighbourPrefix2 = rungFor(buildQueryLadder({ title: 'Alpha: Beta Gamma: Gamma', author: 'A' }), 'prefix(2)');
  const parenPrefix1 = rungFor(buildQueryLadder({ title: 'Star (Deluxe) Wars: Haunted Starlight', author: 'George Mann' }), 'prefix(1)');
  // Pure-ASCII canonical text bypasses the rung-1 degeneracy guard, exposing lossy release collisions (F1).
  const wowPrefix1 = rungFor(buildQueryLadder({ title: 'World of Warcraft: A', author: 'Christie Golden' }), 'prefix(1)');

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

  it.each([
    ['Star Wars: Haunted Starlight', firstLast, true],
    ['Star Wars: The High Republic: Cataclysm', firstLast, false],
    ['The Expanse: Nemesis Games', prefix1, false],
    // Whole-raw containment would false-negative the canonical title (AC12).
    ['Star Wars: The High Republic: Haunted Starlight', firstLast, true],
    // A non-contiguous ordered token walk would incorrectly pass this row (AC12).
    ['Star Wars: Haunted Totally Different Starlight', firstLast, false],
    // Occurrences are space-bounded: `the churner` must not satisfy `the churn` (AC12).
    ['The Churner', prefix1, false],

    // Reading transported `segments` instead of anchored `floorSegments` makes both High Republic siblings pass (#2133 AC5).
    ['01 Star Wars-The High Republic-The Eye of Darkness', prefix2, false],
    ['Star Wars: The High Republic: Cataclysm', prefix2, false],
    ['Star Wars: Haunted Starlight', prefix2, true],
    ['Star Wars: The High Republic: Haunted Starlight', prefix2, true],

    // Canonical-head-only releases provide circular evidence for the suffix query and must fail (#2133 AC7).
    ['The Vital Abyss: An Expanse Novella', churnSuffix1, false],
    ['Gods of Risk: An Expanse Novella', churnSuffix1, false],
    ['The Churn', prefix1, false],
    ['The Churn (Unabridged) [M4B]', prefix1, false],
    ['The Churn: An Expanse Novella', prefix1, true],
    ['The Churn: An Expanse Novella', churnSuffix1, true],

    // A two-segment franchise rung's own single-segment raw text no longer satisfies its floor (#2133 AC8).
    ['Star Wars: Cataclysm', risingStormPrefix1, false],
    ['Star Wars: The Rising Storm', risingStormPrefix1, true],
    ['Star Wars: The Rising Storm (The High Republic)', risingStormPrefix1, true],

    // Collapsed anchors demand `star wars` twice; distinct-only counting admits the sibling, while skipping shared delimiters rejects valid titles (#2133 AC15-16).
    ['Star Wars: The High Republic: The Eye of Darkness', collapsedPrefix2, false],
    ['Star Wars: Cataclysm', collapsedPrefix2, false],
    ['Star Wars: The High Republic: Star Wars', collapsedPrefix2, true],
    ['01 Star Wars-The High Republic-Star Wars', collapsedPrefix2, true],

    // A neighboring segment adds a second demanded `gamma` occurrence (#2133 AC16).
    ['Alpha: Beta Gamma: Delta', neighbourPrefix2, false],
    ['Alpha: Beta Gamma: Gamma', neighbourPrefix2, true],
    // This second-order case is indistinguishable from borrowing `gamma` from the middle segment.
    ['Alpha: Gamma', neighbourPrefix2, false],

    // Both sides must use `titleSegments`; normalizing the release alone rejects the canonical paren-intact title (#2133 AC0/AC16).
    ['Star (Deluxe) Wars: Haunted Starlight', parenPrefix1, true],
    ['Cataclysm (Star Wars: Haunted Starlight)', parenPrefix1, false],

    // `A前夜` and `A後夜` both fold to anchor `a`; dropping `hasDegenerateFullForm` makes both collisions pass (F1).
    ['World of Warcraft: A前夜', wowPrefix1, false],
    ['World of Warcraft: A後夜', wowPrefix1, false],
    // Degeneracy checks the raw release, so lossy content inside a stripped parenthetical still refuses.
    ['World of Warcraft: A (Перед бурей)', wowPrefix1, false],
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

  it('grabs the top result on a full rung without applying the floor (AC33)', () => {
    expect(selectRelaxedCandidate([failing(), passing()], full)).toEqual({ kind: 'grab', result: failing() });
  });

  it('returns none on a full rung with an empty eligible population (AC33, AC40)', () => {
    expect(selectRelaxedCandidate([], full)).toEqual({ kind: 'none' });
  });

  it('returns none with no held event for an empty post-gate list (AC40)', () => {
    expect(selectRelaxedCandidate([], cut)).toEqual({ kind: 'none' });
  });

  // Defining eligibility as the whole ranked list instead of downloadable results returns `hold` (AC40/AC41).
  it('returns none when nothing is downloadable, even though results FAIL the floor (AC40)', () => {
    expect(selectRelaxedCandidate([undownloadable('The Expanse: Nemesis Games')], cut)).toEqual({ kind: 'none' });
  });

  it('returns none when floor-PASSING results exist but none is downloadable (AC40)', () => {
    expect(selectRelaxedCandidate([undownloadable('Star Wars: Haunted Starlight')], cut)).toEqual({ kind: 'none' });
  });

  it('grabs the highest-ranked PASSING downloadable candidate past a failing one (AC31)', () => {
    const results = [failing(), passing('Star Wars: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({ kind: 'grab', result: results[1] });
  });

  it('ignores a non-downloadable passing result when ranking the eligible population (AC41)', () => {
    const results = [undownloadable('Star Wars: Haunted Starlight'), passing('Star Wars: Haunted Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({ kind: 'grab', result: results[1] });
  });

  it('holds naming the top downloadable candidate when a non-downloadable one passed (AC14, AC41)', () => {
    const results = [undownloadable('Star Wars: Haunted Starlight'), failing('Star Wars: The High Republic: Cataclysm')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({
      kind: 'hold',
      releaseTitle: 'Star Wars: The High Republic: Cataclysm',
    });
  });

  it('holds once, naming the highest-ranked downloadable failure (AC14, AC32)', () => {
    const results = [failing('Star Wars: The High Republic: Cataclysm'), failing('Star Wars: Haunted Totally Different Starlight')];
    expect(selectRelaxedCandidate(results, cut)).toEqual({
      kind: 'hold',
      releaseTitle: 'Star Wars: The High Republic: Cataclysm',
    });
  });

  // Prefix coverage exposes the old circular floor: its retained segments equal its query, so siblings corroborated themselves (#2133 AC5/AC6).
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

describe('countOccurrences self-overlap (the #2133 docblock claim)', () => {
  // This title exposes conservative non-overlap through the public surface: tail `A A A` overlaps anchor `a a` (#2142).
  const TITLE = 'A A: Whatever: A A A';

  it('demands the conservative count — the self-overlapping tail adds ONE "a a", not two', () => {
    // An overlapping scan demands three `a a` copies; trailing-delimiter restart demands two.
    const rung = segmentCutRungs(TITLE)[0]!;
    expect([...rung.floorSegments].sort()).toEqual(['a a', 'a a', 'a a a']);
  });

  it('errs toward hold: a release that is only the tail fails the floor', () => {
    const rung = segmentCutRungs(TITLE)[0]!;
    expect(passesSegmentFloor('A A A', rung)).toBe(false);
    expect(passesSegmentFloor(TITLE, rung)).toBe(true);
  });
});
