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
    });
    expect(ladder[0]!.query).toBe('Star Wars The High Republic Haunted Starlight George Mann');
  });

  // AC1, AC2, AC3, AC4 — the deep-franchise live example, asserted as a full
  // ordered array. The generator's order is a TOTAL order (#2096 G4), so this
  // pins membership, author-major ordering, admission, and each rung's floor.
  it('emits the full author-major ladder for the deep-franchise live example (AC1-AC4)', () => {
    const ladder = buildQueryLadder({
      title: 'Star Wars: The High Republic: Haunted Starlight',
      author: 'George Mann',
    });

    expect(ladder).toEqual([
      {
        query: 'Star Wars The High Republic Haunted Starlight George Mann',
        author: 'George Mann',
        variant: null,
        segments: [],
      },
      {
        query: 'star wars the high republic George Mann',
        author: 'George Mann',
        variant: { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
        segments: ['star wars', 'the high republic'],
      },
      {
        query: 'the high republic haunted starlight George Mann',
        author: 'George Mann',
        variant: { raw: 'the high republic haunted starlight', tag: 'suffix(2)', parensStripped: true, lossy: false },
        segments: ['the high republic', 'haunted starlight'],
      },
      {
        query: 'star wars haunted starlight George Mann',
        author: 'George Mann',
        variant: { raw: 'star wars haunted starlight', tag: 'first+last', parensStripped: true, lossy: false },
        segments: ['star wars', 'haunted starlight'],
      },
      {
        query: 'star wars the high republic haunted starlight',
        author: undefined,
        variant: { raw: 'star wars the high republic haunted starlight', tag: 'full', parensStripped: false, lossy: false },
        segments: [],
      },
      {
        query: 'star wars the high republic',
        author: undefined,
        variant: { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
        segments: ['star wars', 'the high republic'],
      },
      {
        query: 'the high republic haunted starlight',
        author: undefined,
        variant: { raw: 'the high republic haunted starlight', tag: 'suffix(2)', parensStripped: true, lossy: false },
        segments: ['the high republic', 'haunted starlight'],
      },
      {
        query: 'star wars haunted starlight',
        author: undefined,
        variant: { raw: 'star wars haunted starlight', tag: 'first+last', parensStripped: true, lossy: false },
        segments: ['star wars', 'haunted starlight'],
      },
    ]);

    // `prefix(1)` = "star wars" retains 1 against a budget of ceil(3/2) = 2 —
    // the pure-franchise rung the budget exists to suppress.
    expect(shape(ladder)).not.toContain('prefix(1)@George Mann');
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

describe('passesSegmentFloor', () => {
  const haunted = buildQueryLadder({ title: 'Star Wars: The High Republic: Haunted Starlight', author: 'George Mann' });
  const firstLast = rungFor(haunted, 'first+last');
  const churn = buildQueryLadder({ title: 'The Churn: An Expanse Novella', author: 'James S. A. Corey' });
  const prefix1 = rungFor(churn, 'prefix(1)');

  // AC10 — a `full` rung is not a segment cut, so there is nothing to corroborate.
  it('short-circuits true for a full-tagged rung without inspecting the title (AC10)', () => {
    const full = rungFor(buildQueryLadder({ title: 'Star Wars: The Rising Storm (The High Republic)', author: 'Cavan Scott' }), 'full');
    expect(full.segments).toEqual([]);
    expect(passesSegmentFloor('Something Entirely Unrelated', full)).toBe(true);
  });

  it('short-circuits true for rung 1, which is never floored', () => {
    expect(passesSegmentFloor('Something Entirely Unrelated', haunted[0]!)).toBe(true);
  });

  // AC11, AC12 — the ground-truth verdicts plus the two load-bearing
  // counterfactual rows.
  it.each([
    // AC11 reference verdicts.
    ['Star Wars: Haunted Starlight', firstLast, true],
    ['Star Wars: The High Republic: Cataclysm', firstLast, false],
    ['The Churn (Unabridged) [M4B]', prefix1, true],
    ['The Expanse: Nemesis Games', prefix1, false],
    // AC12 — the book's own canonical title must never false-negative.
    // COUNTERFACTUAL: whole-`raw` string containment flips ONLY this row to false.
    ['Star Wars: The High Republic: Haunted Starlight', firstLast, true],
    // AC12 — contiguity. COUNTERFACTUAL: a non-contiguous ordered token walk
    // flips ONLY this row to true.
    ['Star Wars: Haunted Totally Different Starlight', firstLast, false],
    // AC12 — space-bounded. "the churner" must not satisfy "the churn".
    ['The Churner', prefix1, false],
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
});
