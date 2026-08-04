import { describe, it, expect } from 'vitest';
import {
  titleVariants,
  titleSegments,
  normalizeTitleForVariantMatch,
  hasDegenerateFullForm,
  normalizeTitleLosslessly,
  MAX_VARIANT_TITLE_LENGTH,
  MAX_VARIANT_SEGMENTS,
} from './title-variants.js';
import type { Variant } from './title-variants.js';

/**
 * The EFFECTIVE segment set: `titleSegments` normalized and empty-dropped. This
 * is the ONLY representation the ladder's segment budget divides (#2104 D3) —
 * the raw list is not, because `colonSegments` keeps punctuation-only text that
 * `normalizeTitleForVariantMatch` then erases.
 */
function effectiveSegments(title: string): string[] {
  return titleSegments(title).map(normalizeTitleForVariantMatch).filter((s) => s.length > 0);
}

/** Every `raw` in a well-formed variant set is non-empty and already collapsed/lowercased. */
function assertWellFormed(variants: Variant[]): void {
  for (const v of variants) {
    expect(v.raw).not.toBe('');
    expect(v.raw).toBe(v.raw.trim());
    expect(v.raw).toBe(v.raw.toLowerCase());
  }
  // Deduped on the collapsed key — no `raw` appears twice.
  expect(new Set(variants.map((v) => v.raw)).size).toBe(variants.length);
}

describe('normalizeTitleForVariantMatch', () => {
  // The colon is a SEPARATOR now, not a truncation point (#2096). The pre-#2096
  // normalizer returned 'foo' here, which is exactly the Chapterhouse defect.
  it('treats `:` as a separator instead of truncating', () => {
    expect(normalizeTitleForVariantMatch('Foo: A Tale of Two Cities')).toBe('foo a tale of two cities');
    expect(normalizeTitleForVariantMatch('Chapterhouse: Dune')).toBe('chapterhouse dune');
  });

  // The generic paren/bracket strip moved to the DERIVED axis (`titleVariants`),
  // so the scalar form retains the annotation text.
  it('retains generic parenthetical/bracket text (that axis is derived, not scalar)', () => {
    expect(normalizeTitleForVariantMatch('Foundation (1951)')).toBe('foundation 1951');
    expect(normalizeTitleForVariantMatch('Foundation [1951]')).toBe('foundation 1951');
  });

  // AC7: the edition tail is load-bearing in the SCALAR normalizer. Demote it to
  // the derived axis and both sides of 'Foo (Audio)' ≡ 'Foo (Unabridged)' become
  // DERIVED forms, which the asymmetric rule forbids from pairing.
  it('strips Unabridged / Audio / Audible edition tails in the scalar form', () => {
    expect(normalizeTitleForVariantMatch('Foo (Unabridged)')).toBe('foo');
    expect(normalizeTitleForVariantMatch('Foo (Audio)')).toBe('foo');
    expect(normalizeTitleForVariantMatch('Foo (Audible)')).toBe('foo');
    expect(normalizeTitleForVariantMatch('Foo [Unabridged]')).toBe('foo');
  });

  it('case-folds, drops punctuation, collapses whitespace', () => {
    expect(normalizeTitleForVariantMatch('The Wind Through the Keyhole')).toBe('the wind through the keyhole');
    expect(normalizeTitleForVariantMatch('The Wind through the Keyhole')).toBe('the wind through the keyhole');
  });

  it('normalizes curly apostrophes to straight', () => {
    expect(normalizeTitleForVariantMatch('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
  });

  it('canonicalizes `&` / `+` to the word `and`', () => {
    expect(normalizeTitleForVariantMatch('Night of Cake & Puppets')).toBe('night of cake and puppets');
    expect(normalizeTitleForVariantMatch('Cake + Puppets')).toBe('cake and puppets');
  });

  it('folds combining diacritics without transliterating non-decomposing letters', () => {
    expect(normalizeTitleForVariantMatch('Les Misérables')).toBe('les miserables');
    expect(normalizeTitleForVariantMatch('Straße')).toBe('stra e');
  });
});

/**
 * `titleSegments` (#2104 D19) — the segment primitive, a pure composition of the
 * two folds `titleVariants` already runs (`stripParentheticals` then
 * `colonSegments`). This suite owns only GENERATOR-observable facts: the raw
 * segment list, the effective set derived from it, and what the emitted tags do
 * and do not reveal. Ladder ADMISSION is a server-side policy and its assertions
 * live in `src/server/services/search-query-ladder.test.ts`.
 */
describe('titleSegments', () => {
  it('splits the PAREN-STRIPPED base on qualifying colons, and its effective set is the count that matters', () => {
    const title = 'star wars: the high republic: Light of the Jedi (New Order Series)';
    // Raw: the parenthetical is gone before segmentation, so its text never
    // becomes a segment and its (absent here) colon could never shear one.
    expect(titleSegments(title)).toEqual(['star wars', ' the high republic', ' Light of the Jedi  ']);
    // `E.length` is the `segmentCount` the ladder's budget divides — NOT the raw
    // length. They agree here only because no segment normalizes away.
    expect(effectiveSegments(title)).toEqual(['star wars', 'the high republic', 'light of the jedi']);
  });

  it('keeps punctuation-only segments raw — they are exactly what the effective set drops', () => {
    // Each pair is (raw length, effective length). The divergence is the whole
    // reason the ladder counts the effective set: `colonSegments` keeps any
    // segment with non-whitespace text, `normalizeTitleForVariantMatch` erases
    // punctuation-only text.
    const cases: Array<[string, number, number]> = [
      ['Star Wars: ---: The High Republic: Haunted Starlight', 4, 3],
      ['---: Alpha: Beta: Gamma', 4, 3],
      ['---: Beta: Gamma: Delta: Eps', 5, 4],
      ['---: Alpha: Beta: Gamma: ---', 5, 3],
    ];
    for (const [title, rawLength, effectiveLength] of cases) {
      expect(titleSegments(title)).toHaveLength(rawLength);
      expect(effectiveSegments(title)).toHaveLength(effectiveLength);
    }
  });

  it('exposes a count neither the emitted tags nor their maximum can recover', () => {
    // Generator dedup makes the emitted `n` values NON-DENSE: five raw segments
    // (three effective) all collapse onto the same `alpha beta gamma` text, so
    // the largest tag emitted is `prefix(3)`. Neither 5 nor 3 is readable from
    // the tag set — which is why D19 exports the segmenter instead of letting
    // the ladder infer a budget from `max(emitted n) + 1`.
    const title = '---: Alpha: Beta: Gamma: ---';
    expect(titleSegments(title)).toHaveLength(5);
    expect(effectiveSegments(title)).toEqual(['alpha', 'beta', 'gamma']);

    const tags = titleVariants(title).map((v) => v.tag);
    expect(tags).not.toContain('prefix(5)');
    expect(tags).not.toContain('prefix(4)');
    expect(tags).toContain('prefix(3)');
  });

  it('returns [] for a title with no segment-bearing text', () => {
    expect(titleSegments('')).toEqual([]);
    expect(titleSegments('   ')).toEqual([]);
  });

  // T12 / #2109 AC6 — `titleSegments` is explicitly NOT clamped. It is documented
  // as returning the EXACT base slices the generator derives from, so silently
  // capping it would break that contract (and the ladder's `effective` count with
  // it). It is already linear, and `admitVariants` only admits unfloored `full`
  // variants once the derived axis is empty, so no inconsistency arises.
  it('is NOT clamped — returns the full raw segment list past the generator cap (T12)', () => {
    // 2400 chars / 300 segments: well past both MAX_VARIANT_TITLE_LENGTH and
    // MAX_VARIANT_SEGMENTS, which `titleVariants` degrades on and this does not.
    const segments = titleSegments('ab: '.repeat(600));
    expect(segments).toHaveLength(300);
    expect(effectiveSegments('ab: '.repeat(600))).toHaveLength(300);
  });
});

/**
 * #2104 AC30 — `titleSegments` is the ONE export this module gains. Everything
 * else #2096 froze here stays exactly as it was, so a consumer of the generator
 * cannot quietly become a co-owner of it.
 *
 * Sorted before comparison: a module namespace in native Node ESM sorts its own
 * keys, but under Vitest a dynamic import resolves through Vite's SSR transform
 * to an ordinary object in SOURCE order. Sorting is ordering-agnostic and
 * asserts exactly the property under test — the SET of exports.
 */
describe('public export surface (#2104 AC30)', () => {
  it('exports exactly the #2096 surface plus titleSegments', async () => {
    const ns = await import('./title-variants.js');
    // #2109 AC11 — a deliberate TWO-name addition for the AC5 clamp constants,
    // and nothing else. `applyCommonFolds` (AC8) stays private: the extraction
    // is internal DRY, not a new contract, and keeping it unexported is what
    // leaves this assertion a meaningful signal.
    expect(Object.keys(ns).sort()).toEqual([
      'MAX_VARIANT_SEGMENTS',
      'MAX_VARIANT_TITLE_LENGTH',
      'hasDegenerateFullForm',
      'normalizeTitleForVariantMatch',
      'normalizeTitleLosslessly',
      'titleSegments',
      'titleVariants',
    ]);
  });
});

describe('titleVariants', () => {
  // AC5 — the full worked array. Pins membership, tags, `parensStripped` flags
  // and the G4 total order end to end in one assertion.
  it('emits the full ordered array for a deep-franchise title (AC5)', () => {
    expect(titleVariants('star wars: the high republic: Light of the Jedi (New Order Series)')).toEqual([
      { raw: 'star wars the high republic light of the jedi new order series', tag: 'full', parensStripped: false, lossy: false },
      { raw: 'star wars the high republic light of the jedi', tag: 'full', parensStripped: true, lossy: false },
      { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
      { raw: 'the high republic light of the jedi', tag: 'suffix(2)', parensStripped: true, lossy: false },
      { raw: 'star wars light of the jedi', tag: 'first+last', parensStripped: true, lossy: false },
      { raw: 'star wars', tag: 'prefix(1)', parensStripped: true, lossy: false },
      { raw: 'light of the jedi', tag: 'suffix(1)', parensStripped: true, lossy: false },
    ]);
  });

  // AC2 / G1 — parens are stripped BEFORE colon segmentation, so a colon living
  // inside a parenthetical can never shear a segment. The literal cross product
  // this guards against would emit `prefix(1) = 'the spiral path world of warcraft'`.
  //
  // Scope note: the assertion is over the DERIVED variants. G1 gives the
  // parens-INTACT string exactly one variant — the FULL normalized form — and
  // that form retains its parenthetical text by construction (the same fixture
  // pair below pins `the high republic` surviving in the parens-intact full).
  // AC2's prose says "no variant"; taken literally that contradicts G1 and the
  // Star Wars fixture, so the precise property is asserted here instead.
  it('never shears a colon that lives inside a parenthetical (AC2 / G1)', () => {
    const variants = titleVariants('The Spiral Path (World of Warcraft: Traveler, Book 2)');
    assertWellFormed(variants);

    const derived = variants.filter((v) => v.parensStripped);
    for (const v of derived) {
      expect(v.raw).not.toContain('world of warcraft');
    }
    // No sheared variant exists at all: the paren-stripped base has no colon.
    expect(derived.map((v) => v.raw)).toEqual(['the spiral path']);
    expect(variants.filter((v) => v.raw.includes('world of warcraft'))).toEqual([
      { raw: 'the spiral path world of warcraft traveler book 2', tag: 'full', parensStripped: false, lossy: false },
    ]);
  });

  /**
   * #2109 (a) — the strip is a depth-counting SCAN, so it is agnostic to whether
   * the groups are balanced or nested. The regex form it replaced matched only
   * balanced, non-nested groups, which meant a single missing `)` — an ordinary
   * truncation artefact in community-edited metadata — let the parenthetical's
   * text AND its colon back into the derived axis, emitting exactly the sheared
   * `prefix(1)` that G1 exists to forbid.
   *
   * Every exclusion below is scoped to the DERIVED axis (`parensStripped: true`)
   * for the reason the G1 control above already states: G1 mandates that the
   * parens-INTACT `full` retain its parenthetical text, so a global exclusion
   * would be unsatisfiable by any correct implementation. Each case therefore
   * asserts the intact `full` is still present and byte-identical to today's.
   */
  describe('balanced-agnostic paren stripping (#2109 AC1-AC3)', () => {
    const UNTERMINATED = 'The Spiral Path (World of Warcraft: Traveler, Book 2';
    const TERMINATED = 'The Spiral Path (World of Warcraft: Traveler, Book 2)';

    // T1 — the G1 shear an unterminated group used to produce.
    it('strips an unterminated group to end-of-string (T1)', () => {
      const variants = titleVariants(UNTERMINATED);
      assertWellFormed(variants);

      const derived = variants.filter((v) => v.parensStripped);
      expect(derived.map((v) => v.raw)).toEqual(['the spiral path']);
      // `world of warcraft` survives ONLY in the parens-intact full (G1).
      expect(variants.filter((v) => v.raw.includes('world of warcraft'))).toEqual([
        { raw: 'the spiral path world of warcraft traveler book 2', tag: 'full', parensStripped: false, lossy: false },
      ]);
    });

    // T2 — AC2 as a RELATION rather than a literal: the missing `)` may change
    // the parens-intact full, and nothing else.
    it('derives the same set from an unterminated group as from its balanced twin (T2)', () => {
      const strippedOf = (title: string): string[] =>
        titleVariants(title).filter((v) => v.parensStripped).map((v) => v.raw);
      expect(strippedOf(UNTERMINATED)).toEqual(strippedOf(TERMINATED));
      expect(strippedOf(UNTERMINATED)).toEqual(['the spiral path']);
    });

    // T3 — a nested group strips as ONE unit. The regex form closed at the first
    // `)`, so `Qux` and the inner colon leaked into the derived axis.
    it('strips nested groups as a single unit (T3)', () => {
      const variants = titleVariants('Foo (Bar (Baz): Qux) Quux');
      assertWellFormed(variants);

      const derived = variants.filter((v) => v.parensStripped);
      for (const v of derived) {
        expect(v.raw).not.toContain('qux');
      }
      expect(derived.find((v) => v.tag === 'full')!.raw).toBe('foo quux');
      expect(variants.find((v) => v.tag === 'full' && !v.parensStripped)!.raw).toBe('foo bar baz qux quux');
    });

    // T4 — the fabricated-title form of the same defect: `dune edition` is a
    // title no edition of Dune has ever carried.
    it('does not fabricate a title from a nested group (T4)', () => {
      const variants = titleVariants('Dune (Deluxe (2nd) Edition: Annotated)');
      assertWellFormed(variants);

      expect(variants.some((v) => v.tag === 'prefix(1)' && v.raw === 'dune edition')).toBe(false);
      expect(variants.find((v) => v.parensStripped && v.tag === 'full')!.raw).toBe('dune');
      expect(variants.find((v) => v.tag === 'full' && !v.parensStripped)!.raw).toBe('dune deluxe 2nd edition annotated');
    });

    // T5 — depth floors at 0, so a stray closer is inert: it folds to a space
    // exactly as the regex form left it.
    it.each([['Foo) Bar'], ['Foo] Bar']])('leaves a stray closer inert in %j (T5)', (title) => {
      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(variants.find((v) => v.tag === 'full')!.raw).toBe('foo bar');
    });

    // T6 — the bracket form of T1. Both delimiter kinds share the counter.
    it('strips an unterminated bracket group to end-of-string (T6)', () => {
      const variants = titleVariants('Foo [Bar: Baz');
      assertWellFormed(variants);
      expect(variants.some((v) => v.tag === 'prefix(1)' && v.raw === 'foo bar')).toBe(false);
      expect(variants.filter((v) => v.parensStripped).map((v) => v.raw)).toEqual(['foo']);
    });

    /**
     * T7 (spec-review F4) — mismatched delimiter KINDS. This asserts AC1's
     * answer, not whatever the implementation happens to do: one shared depth
     * counter means `]` closes the `(`, so `Bar` is swallowed and `Baz` survives
     * → `foo baz`. A delimiter-KIND stack (where `]` would not close a `(`, and
     * the group therefore ran to end-of-string) yields `foo` instead and fails
     * here — which is the entire reason the case is pinned.
     */
    it('closes a group on either delimiter kind — one shared depth counter (T7)', () => {
      const variants = titleVariants('Foo (Bar] Baz');
      assertWellFormed(variants);
      expect(variants.find((v) => v.tag === 'full' && !v.parensStripped)!.raw).toBe('foo bar baz');
      expect(variants.find((v) => v.parensStripped && v.tag === 'full')!.raw).toBe('foo baz');
      expect(variants.some((v) => /^(?:prefix|suffix)\(/.test(v.tag) || v.tag === 'first+last')).toBe(false);
    });
  });

  it('keeps the parens-intact full and derives the rest from the stripped base', () => {
    const variants = titleVariants('Star Wars: The Rising Storm (The High Republic)');
    assertWellFormed(variants);

    const full = variants.find((v) => v.tag === 'full' && !v.parensStripped)!;
    expect(full.raw).toContain('the high republic');
    expect(variants.filter((v) => v.parensStripped).map((v) => v.raw)).toEqual([
      'star wars the rising storm',
      'star wars',
      'the rising storm',
    ]);
  });

  // G3 — a `:` is a boundary only when its trimmed left context is >= 3 chars,
  // the same COLON_PREFIX_MIN threshold `src/shared/dedup.ts` applies.
  describe('colon-boundary threshold (G3)', () => {
    it.each([
      ['X: Y', 'x y'],
      ['IT: Chapter Two', 'it chapter two'],
    ])('does not segment %s (left context < 3)', (title, expectedFull) => {
      const variants = titleVariants(title);
      expect(variants).toEqual([{ raw: expectedFull, tag: 'full', parensStripped: false, lossy: false }]);
    });

    it('segments `A B: C` — internal whitespace counts toward the 3-char left context', () => {
      expect(titleVariants('A B: C')).toEqual([
        { raw: 'a b c', tag: 'full', parensStripped: false, lossy: false },
        { raw: 'a b', tag: 'prefix(1)', parensStripped: true, lossy: false },
        { raw: 'c', tag: 'suffix(1)', parensStripped: true, lossy: false },
      ]);
    });
  });

  describe('degenerate inputs', () => {
    it.each([[''], ['   '], ['[ ]']])('returns [] for %j', (title) => {
      expect(titleVariants(title)).toEqual([]);
    });

    it.each([[':leading'], ['trailing:'], ['a::b']])(
      'returns a well-formed array with no empty raw for %j',
      (title) => {
        const variants = titleVariants(title);
        expect(variants.length).toBeGreaterThan(0);
        assertWellFormed(variants);
      },
    );

    it('yields no colon-derived variant when the only colon fails the threshold', () => {
      expect(titleVariants('a::b')).toEqual([{ raw: 'a b', tag: 'full', parensStripped: false, lossy: false }]);
    });
  });

  // G2/G4 — `prefix(k)`/`suffix(k)` at k === segment count collapse onto the
  // paren-stripped full and the dedup pass keeps the FIRST occurrence.
  it('emits a collapsed key exactly once, keeping the earliest tag', () => {
    const variants = titleVariants('Foo: Subtitle');
    assertWellFormed(variants);
    expect(variants).toEqual([
      { raw: 'foo subtitle', tag: 'full', parensStripped: false, lossy: false },
      { raw: 'foo', tag: 'prefix(1)', parensStripped: true, lossy: false },
      { raw: 'subtitle', tag: 'suffix(1)', parensStripped: true, lossy: false },
    ]);
    // `prefix(2)` equalled the full and was dropped, not re-emitted under a second tag.
    expect(variants.some((v) => v.tag === 'prefix(2)')).toBe(false);
  });

  // AC6 — no article-stripping axis. Series identity owns articles.
  it('does not strip leading articles', () => {
    expect(titleVariants('The Churn').map((v) => v.raw)).toEqual(['the churn']);
    expect(titleVariants('Churn').map((v) => v.raw)).toEqual(['churn']);
  });

  // AC18 — the #1896 volume-marker collapse in `dedup.ts` is deliberately NOT
  // propagated here: `Saga Book 1` and `Saga Book 2` must stay distinguishable.
  it('does not strip trailing volume markers', () => {
    const one = titleVariants('Saga Book 1');
    const two = titleVariants('Saga Book 2');
    expect(one.map((v) => v.raw)).toEqual(['saga book 1']);
    expect(two.map((v) => v.raw)).toEqual(['saga book 2']);
    expect(one.map((v) => v.raw)).not.toEqual(two.map((v) => v.raw));
  });

  // G2 generator invariant — the tag schema deliberately admits `prefix(1.5)` /
  // `prefix(-2)` so it stays exactly equal to the declared `VariantTag` type
  // (AC14). That `n` is a POSITIVE INTEGER is the generator's guarantee, so it
  // is observed here rather than at the schema layer.
  it('only ever emits a positive integer n in prefix(n) / suffix(n)', () => {
    const corpus = [
      'star wars: the high republic: Light of the Jedi (New Order Series)',
      'The Farseer: Assassin\'s Apprentice',
      'a: b: c: d: e',
      'Foo: Subtitle',
      'A B: C',
      'trailing:',
    ];
    const tags = corpus.flatMap((title) => titleVariants(title).map((v) => v.tag));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const match = /^(?:prefix|suffix)\((.+)\)$/.exec(tag);
      if (!match) continue;
      const n = Number(match[1]);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  /**
   * #2110 — per-SLICE character survival. `hasDegenerateFullForm` answers "did
   * the ASCII fold eat identity-bearing content?" for a whole title; `lossy`
   * asks it of every slice, computed on the RAW slice text before
   * normalization. The pairing rule refuses a lossy variant as OFFERED
   * evidence, which is the variant-level form of the guard #2096 applied only
   * to whole FULL forms.
   */
  describe('per-variant lossy flag (#2110)', () => {
    // The verified D3 table, asserted as full arrays so membership, order and
    // the flag are all pinned together.
    it('flags the paren-stripped full of a Russian-edition-with-translation title', () => {
      // `prefix(1)` ('World of Warcraft') would be non-lossy, but it collapses
      // onto the earlier lossy entry and dedup keeps the FIRST occurrence — so
      // the bare franchise prefix is never offered as evidence at all.
      expect(titleVariants('World of Warcraft: Тревелер (Traveler)')).toEqual([
        { raw: 'world of warcraft traveler', tag: 'full', parensStripped: false, lossy: true },
        { raw: 'world of warcraft', tag: 'full', parensStripped: true, lossy: true },
      ]);
    });

    it('flags only the slice that lost characters, leaving its siblings usable', () => {
      expect(titleVariants('Star Wars: 前夜Thrawn')).toEqual([
        { raw: 'star wars thrawn', tag: 'full', parensStripped: false, lossy: true },
        { raw: 'star wars', tag: 'prefix(1)', parensStripped: true, lossy: false },
        { raw: 'thrawn', tag: 'suffix(1)', parensStripped: true, lossy: true },
      ]);
    });

    it('leaves the pinned #2096 true positive non-lossy', () => {
      // 'Sønner' is degenerate as a WHOLE title (ø does not decompose), but the
      // fragment it offers lost nothing, so the pairing survives.
      expect(titleVariants("Sønner: Assassin's Apprentice")).toEqual([
        { raw: "s nner assassin's apprentice", tag: 'full', parensStripped: false, lossy: true },
        { raw: 's nner', tag: 'prefix(1)', parensStripped: true, lossy: true },
        { raw: "assassin's apprentice", tag: 'suffix(1)', parensStripped: true, lossy: false },
      ]);
    });

    /**
     * Mixed corpus for the two flag properties — ASCII, Latin-accented,
     * Cyrillic, CJK-mixed, non-decomposing Latin and an out-of-block mark.
     */
    const mixedCorpus = [
      'Chapterhouse: Dune',
      'The Churn: An Expanse Novella',
      'star wars: the high republic: Light of the Jedi (New Order Series)',
      'Les Misérables: Tome I',
      'Café: A Novel',
      'World of Warcraft: Перед бурей',
      'World of Warcraft: Тревелер (Traveler)',
      'Star Wars: 前夜Thrawn',
      'World of Warcraft: A前夜',
      "Sønner: Assassin's Apprentice",
      'Straße: Beyond the Dark Portal',
      'Sa᷀ga: Book One',
      'Foundation (1951)',
      'Перед бурей',
      '[ ]',
    ];

    // AC13 (D5) — the parens-intact FULL variant is pushed first, from the whole
    // title, so its flag IS `hasDegenerateFullForm` by construction. Inert for
    // the derived arms, but it makes the flag self-consistent.
    it('sets the parens-intact full variant flag to hasDegenerateFullForm(title)', () => {
      const withFull = mixedCorpus.filter((title) => normalizeTitleForVariantMatch(title).length > 0);
      expect(withFull.length).toBeGreaterThan(0);
      for (const title of withFull) {
        const full = titleVariants(title).find((v) => v.tag === 'full' && !v.parensStripped);
        expect(full).toBeDefined();
        expect(full!.lossy).toBe(hasDegenerateFullForm(title));
      }
    });

    // AC14 (D3 invariant) — a slice cannot drop a character the whole title
    // kept, so "the whole title is non-degenerate" implies every slice is
    // non-lossy. This is what makes first-wins dedup safe: "first non-lossy,
    // later lossy" is impossible.
    it('emits no lossy variant for a title that is not degenerate as a whole', () => {
      const nonDegenerate = mixedCorpus.filter((title) => !hasDegenerateFullForm(title));
      expect(nonDegenerate.length).toBeGreaterThan(0);
      for (const title of nonDegenerate) {
        expect(titleVariants(title).filter((v) => v.lossy)).toEqual([]);
      }
    });
  });

  /**
   * #2109 (b) — the input clamp.
   *
   * The derived loop does an O(L) slice/join/normalize per colon segment, so it
   * is O(L²) on colon-dense input: 8 KB measured at ~360 ms, 16 KB at ~1 370 ms,
   * 64 KB at ~27 s of synchronous event-loop blocking. The input is
   * community-edited Hardcover member titles, and generation runs inside the
   * `persistMembers` transaction, which serializes every other libSQL write.
   *
   * The clamp REMOVES WORK; it does not add a return shape. Both FULL pushes
   * still run through the unchanged first-key-wins dedup, so cardinality is 1 or
   * 2 depending on whether the paren-stripped form normalizes differently — a
   * consequence of dedup, never a rule of the clamp. The one observable the
   * clamp itself owns is asserted in every case below: NO `prefix(n)`,
   * `suffix(n)` or `first+last` variant is emitted.
   *
   * The title text is never TRUNCATED. Truncating manufactures a sheared
   * fragment — precisely what G1 forbids — whereas dropping the derived axis can
   * only ever produce FEWER variants, so the failure mode is a false refusal (a
   * missing "In Library" badge, which position rescue already covers) and never
   * a false pair.
   */
  describe('input clamp (#2109 AC5/AC6)', () => {
    const derivedTagsOf = (title: string): string[] =>
      titleVariants(title).map((v) => v.tag).filter((tag) => tag !== 'full');

    it('exports the two caps as the thresholds under test', () => {
      expect(MAX_VARIANT_TITLE_LENGTH).toBe(2048);
      expect(MAX_VARIANT_SEGMENTS).toBe(32);
    });

    // T8 — the LENGTH branch's own observation point. 2306 chars but only 2
    // segments, so it trips the length cap and nothing else: delete the length
    // check and this fails; delete the segment check and it still passes.
    // ('ab: '.repeat(600) would trip BOTH predicates and isolate neither.)
    it('degrades on length alone, with the segment count well under its cap (T8)', () => {
      const title = 'x'.repeat(2300) + ': tail';
      expect(title.length).toBe(2306);
      expect(titleSegments(title)).toHaveLength(2);

      // No parenthetical, so both FULL pushes collapse onto the same key — the
      // same single-entry collapse every no-parenthesis fixture already shows.
      expect(titleVariants(title)).toEqual([
        { raw: `${'x'.repeat(2300)} tail`, tag: 'full', parensStripped: false, lossy: false },
      ]);
    });

    // T9 — the SEGMENT branch's own observation point. 200 chars, far under the
    // length cap, 40 segments. Delete the segment check and this fails; delete
    // the length check and it still passes.
    it('degrades on segment count alone, well under the length cap (T9)', () => {
      const title = 'abc: '.repeat(40);
      expect(title.length).toBe(200);
      expect(title.length).toBeLessThanOrEqual(MAX_VARIANT_TITLE_LENGTH);
      expect(titleSegments(title)).toHaveLength(40);

      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(variants).toHaveLength(1);
      expect(variants[0]!.tag).toBe('full');
      expect(derivedTagsOf(title)).toEqual([]);
    });

    // T9b — the TWO-FULL clamped case: the paren-stripped form normalizes
    // differently from the intact one, so dedup keeps both. `(Deluxe)`, not
    // `(Unabridged)`/`(Audio)`/`(Audible)` — those are peeled by the SCALAR
    // normalizer itself, which would collapse the two FULL forms back into one
    // and silently make this a duplicate of T8.
    it('still emits both FULL forms when the paren-stripped one differs (T9b)', () => {
      const title = '(Deluxe) ' + 'ab: '.repeat(600);
      expect(title.length).toBe(2409);

      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(variants).toHaveLength(2);
      expect(variants.map((v) => ({ tag: v.tag, parensStripped: v.parensStripped }))).toEqual([
        { tag: 'full', parensStripped: false },
        { tag: 'full', parensStripped: true },
      ]);
      expect(variants[0]!.raw.startsWith('deluxe ab')).toBe(true);
      expect(variants[1]!.raw.startsWith('ab ab')).toBe(true);
      expect(derivedTagsOf(title)).toEqual([]);
    });

    // T10 — both sides of both caps. The predicate is EXCEEDS, so at-cap still
    // derives and cap+1 degrades. Off-by-one is the entire risk surface of a
    // threshold, so neither side is sampled.
    describe('boundary quartet (T10)', () => {
      it('derives at exactly MAX_VARIANT_TITLE_LENGTH', () => {
        const title = 'x'.repeat(2042) + ': tail';
        expect(title.length).toBe(MAX_VARIANT_TITLE_LENGTH);
        expect(titleVariants(title).map((v) => v.tag)).toEqual(['full', 'prefix(1)', 'suffix(1)']);
      });

      it('degrades one character past MAX_VARIANT_TITLE_LENGTH', () => {
        const title = 'x'.repeat(2043) + ': tail';
        expect(title.length).toBe(MAX_VARIANT_TITLE_LENGTH + 1);
        expect(derivedTagsOf(title)).toEqual([]);
      });

      it('derives at exactly MAX_VARIANT_SEGMENTS', () => {
        const title = 'abc: '.repeat(32);
        expect(titleSegments(title)).toHaveLength(MAX_VARIANT_SEGMENTS);
        expect(title.length).toBeLessThanOrEqual(MAX_VARIANT_TITLE_LENGTH);
        expect(derivedTagsOf(title).length).toBeGreaterThan(0);
      });

      it('degrades one segment past MAX_VARIANT_SEGMENTS', () => {
        const title = 'abc: '.repeat(33);
        expect(titleSegments(title)).toHaveLength(MAX_VARIANT_SEGMENTS + 1);
        expect(title.length).toBeLessThanOrEqual(MAX_VARIANT_TITLE_LENGTH);
        expect(derivedTagsOf(title)).toEqual([]);
      });
    });

    /**
     * T17b — the performance AC, asserted as a SHAPE rather than a wall clock.
     *
     * A timing assertion is flaky in CI, so the property under test is that the
     * result does not grow with N: past the cap the derived axis is empty for
     * every N, which is the same observable T8/T9 use. The wall clock enters
     * only through vitest's default 5 s per-test timeout, and only as a coarse
     * backstop — the pre-clamp code measured ~27 s on the 64 KB input below (8
     * KB ≈ 360 ms, 16 KB ≈ 1 370 ms, clean 4x per 2x), so it would time out
     * here, while the clamped code returns in single-digit milliseconds.
     */
    it.each([[600], [6_000], [16_000]])('emits no derived variant for a %i-repeat colon-dense title (T17b)', (n) => {
      const title = 'ab: '.repeat(n);
      expect(title.length).toBeGreaterThan(MAX_VARIANT_TITLE_LENGTH);
      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(derivedTagsOf(title)).toEqual([]);
    });
  });
});

/**
 * Surfaced by the AC17 blast check against the live library (633 books) — the
 * unknown-corpus defect that sweep exists to find. The scalar normalizer's ASCII
 * fold can eat a title's ONLY distinguishing content, leaving a "complete" form
 * that is really a bare franchise prefix.
 */
describe('hasDegenerateFullForm', () => {
  it('flags a title whose colon tail is erased by the ASCII fold (the live case)', () => {
    // Every Cyrillic character is dropped by `[^a-z0-9' ]+`, so the FULL form is
    // indistinguishable from the franchise prefix shared by ~40 sibling books.
    expect(normalizeTitleForVariantMatch('World of Warcraft: Перед бурей')).toBe('world of warcraft');
    expect(hasDegenerateFullForm('World of Warcraft: Перед бурей')).toBe(true);
  });

  it.each([
    ['World of Warcraft: 前夜'],
    ['Star Wars: Επεισόδιο'],
    // #1547 scope pin: ß/ø/æ do not decompose, so an all-non-decomposing tail
    // erases the same way a non-Latin script does.
    ['Star Wars: Æ'],
  ])('flags %j — any tail that leaves nothing behind', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(true);
  });

  // F8: detection must not depend on WHERE the erased content sits. The earlier
  // structural (colon-segment) detector missed every one of these — the paren and
  // bracket forms because the tail was stripped before the decision, and the
  // colon-less form because there was no boundary to find. Token survival is the
  // property they share.
  it.each([
    ['World of Warcraft: (Перед бурей)', 'erased tail in parentheses after a colon'],
    ['World of Warcraft: [Перед бурей]', 'erased tail in brackets after a colon'],
    ['World of Warcraft (Перед бурей)', 'erased tail in parentheses with NO colon'],
    ['World of Warcraft [Перед бурей]', 'erased tail in brackets with NO colon'],
    ['Перед бурей: World of Warcraft', 'erased content LEADING the surviving text'],
  ])('flags %j — %s', (title) => {
    expect(normalizeTitleForVariantMatch(title)).toBe('world of warcraft');
    expect(hasDegenerateFullForm(title)).toBe(true);
  });

  // F10: PARTIAL loss is loss. An earlier token-level test asked whether a whole
  // token vanished, so a token mixing surviving and erased characters looked
  // safe — `"A前夜"` and `"A後夜"` both reduce to `a`, and the two different books
  // matched. The question belongs at the CHARACTER level, where the fold
  // actually discards information.
  it.each([
    ['World of Warcraft: A前夜'],
    ['World of Warcraft: A後夜'],
    ['Star Wars: Episode1エピソード'],
  ])('flags %j — erased characters mixed INTO a surviving token', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(true);
  });

  it('flags a non-decomposing Latin letter, which the fold genuinely discards', () => {
    // #1547 pins that ß/ø/æ are NOT transliterated, so `straße` -> `stra e` has
    // lost the ß. A prior revision called this "fragmenting, not missing" and let
    // it pass — the same reasoning that let the mixed-token case through.
    expect(normalizeTitleForVariantMatch('Straße')).toBe('stra e');
    expect(hasDegenerateFullForm('Straße')).toBe(true);
    expect(hasDegenerateFullForm('Straße: Beyond the Dark Portal')).toBe(true);
  });

  it.each([
    // Every character survives — these are real, complete titles.
    ['Chapterhouse: Dune'],
    ['World of Warcraft: Beyond the Dark Portal'],
    ['The Farseer: Assassin\'s Apprentice'],
    ['Foo: Subtitle'],
    ['Foundation'],
    ['Foundation (1951)'],
    ['IT: Chapter Two'],
    // A diacritic that FOLDS leaves an all-ASCII form: nothing was discarded.
    ['Star Wars: Éowyn'],
    ['Les Misérables'],
    // The apostrophe is inside the scalar character class, so it is not loss.
    ['Hitchhiker’s Guide'],
  ])('does not flag %j', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(false);
  });

  // F8 named requirement: the colon-inside-parentheses case must stay green —
  // its parenthetical is retained by the scalar form and every token survives.
  it('does not flag the colon-inside-parens fixture', () => {
    expect(hasDegenerateFullForm('The Spiral Path (World of Warcraft: Traveler, Book 2)')).toBe(false);
  });

  /**
   * #2110 AC8 — the AC1 rewrite of `normalizeTitleLosslessly` moves this
   * guard's evidence, so every verdict pinned before it is re-asserted after
   * it, in BOTH polarities. `'Sạch'` is the pin that Vietnamese tone marks live
   * INSIDE U+0300–036F on a Latin base and therefore still fold away.
   */
  describe('verdicts unchanged by the #2110 lossless rewrite (AC8)', () => {
    it.each([['Straße'], ['World of Warcraft: A前夜'], ['World of Warcraft: Перед бурей']])(
      'still flags %j',
      (title) => {
        expect(hasDegenerateFullForm(title)).toBe(true);
      },
    );

    it.each([
      ['Chapterhouse: Dune'],
      ['Foundation (1951)'],
      ['Les Misérables'],
      ["Hitchhiker's Guide"],
      ['Sạch'],
    ])('still does not flag %j', (title) => {
      expect(hasDegenerateFullForm(title)).toBe(false);
    });
  });

  /**
   * #2110 AC9 / D1a — the strip is bounded to U+0300–036F, not to `\p{M}`.
   * U+1DC0 sits on a Latin base but outside the band, and the SCALAR fold does
   * not remove it either: it falls through to `[^a-z0-9' ]+` and fragments the
   * word. Keeping it in the lossless form is what makes the loss visible.
   *
   * Counterfactual (run, verified): widen the strip to
   * `(\p{Script=Latin})\p{M}+` and this fixture is the ONLY failure — every
   * in-block fixture (AC2, AC5, AC7) stays green while a genuinely lossy title
   * is silently trusted as complete.
   */
  it('flags an out-of-block combining mark on a Latin base (AC9)', () => {
    expect(normalizeTitleForVariantMatch('Sa᷀ga: Book One')).toBe('sa ga book one');
    expect(normalizeTitleLosslessly('Sa᷀ga: Book One')).toContain('᷀');
    expect(hasDegenerateFullForm('Sa᷀ga: Book One')).toBe(true);
  });

  it('does not flag a title that normalizes away entirely (the empty guard owns that)', () => {
    expect(hasDegenerateFullForm('[ ]')).toBe(false);
    expect(hasDegenerateFullForm('')).toBe(false);
    // All-Cyrillic: nothing survives, so there is no FULL form to be degenerate
    // ABOUT. G5's empty-variant guard owns this title.
    expect(hasDegenerateFullForm('Перед бурей')).toBe(false);
    expect(titleVariants('Перед бурей')).toEqual([]);
  });
});

describe('normalizeTitleLosslessly', () => {
  it('preserves every script while applying the same folds as the scalar form', () => {
    // #2110 AC7 / D10: the trailing `й` SURVIVES. This fixture used to pin
    // `буреи`, under a comment calling the breve loss "the intended behaviour" —
    // that comment was the defect. The combining-mark strip is script-agnostic
    // only for LATIN bases now: Cyrillic `й` is `и` + breve, and the breve is
    // identity-bearing, not a drift-tolerance nicety. This form is the SOLE
    // evidence backing the degenerate FULL≡FULL arm, so a fold that erases an
    // identity-bearing mark pairs exactly the titles that arm exists to refuse.
    expect(normalizeTitleLosslessly('World of Warcraft: Перед бурей')).toBe('world of warcraft перед бурей');
    expect(normalizeTitleLosslessly('World of Warcraft: Последний страж')).toBe('world of warcraft последний страж');
    expect(normalizeTitleLosslessly('World of Warcraft')).toBe('world of warcraft');
  });

  // AC2/AC3 — the refusals the fold exists to make. Each pair differs ONLY by a
  // combining mark outside the Latin-base band, so a script-agnostic strip
  // collapses them together.
  it.each([
    ['World of Warcraft: май', 'World of Warcraft: маи', 'Cyrillic й is и + breve'],
    ['किताब', 'कितीब', 'Devanagari matra ी is identity-bearing'],
    ['סֵפֶר', 'ספר', 'Hebrew niqqud: pointed is not the unpointed spelling (D2)'],
    ['كِتاب', 'كتاب', 'Arabic harakat: pointed is not the unpointed spelling (D2)'],
  ])('refuses to fold %j onto %j — %s', (a, b) => {
    expect(normalizeTitleLosslessly(a)).not.toBe(normalizeTitleLosslessly(b));
  });

  // AC4 — the keep class includes `\p{M}`, so an out-of-`\p{L}` mark is no
  // longer punctuation. Before #2110 this produced `'क त ब'`: three word
  // fragments, which both false-paired and false-refused.
  it('does not fragment a word whose vowels are combining marks (AC4)', () => {
    expect(normalizeTitleLosslessly('किताब')).not.toContain(' ');
    expect(normalizeTitleLosslessly('किताब')).toBe('किताब');
  });

  // AC6 — the trailing `.normalize('NFC')` is load-bearing, not cosmetic:
  // without it an ordinary (NFC) test literal would not equal the function's
  // decomposed output for any title carrying a surviving mark.
  it.each([['World of Warcraft: Перед бурей'], ['किताब'], ['Les Misérables']])(
    'is independent of the input normalization form for %j (AC6)',
    (title) => {
      expect(normalizeTitleLosslessly(title.normalize('NFC'))).toBe(normalizeTitleLosslessly(title.normalize('NFD')));
    },
  );

  it('distinguishes titles the scalar form collapses together', () => {
    // The property the FULL≡FULL arm actually relies on: three titles that are
    // indistinguishable after the lossy fold stay distinct here.
    const scalar = [
      'World of Warcraft: Перед бурей',
      'World of Warcraft: Последний страж',
      'World of Warcraft',
    ].map(normalizeTitleForVariantMatch);
    expect(new Set(scalar).size).toBe(1);

    const lossless = [
      'World of Warcraft: Перед бурей',
      'World of Warcraft: Последний страж',
      'World of Warcraft',
    ].map(normalizeTitleLosslessly);
    expect(new Set(lossless).size).toBe(3);
  });

  // AC5 — Latin accent drift is still tolerated, byte for byte. The mark strip
  // narrowed to Latin bases; it did not narrow on Latin bases.
  it('tolerates exactly the drift the scalar form tolerates — and no more', () => {
    expect(normalizeTitleLosslessly('  WORLD  of   Warcraft (Unabridged) ')).toBe('world of warcraft');
    expect(normalizeTitleLosslessly('Cake & Puppets')).toBe('cake and puppets');
    expect(normalizeTitleLosslessly('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
    expect(normalizeTitleLosslessly('Les Misérables')).toBe('les miserables');
    expect(normalizeTitleLosslessly('Café')).toBe('cafe');
    // But it does NOT erase a non-Latin script, which is the whole point.
    expect(normalizeTitleLosslessly('Перед бурей')).toBe('перед бурей');
  });
});
