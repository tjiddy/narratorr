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

/** Normalizes raw segments and drops empty folds; this is the ladder's segment budget. */
function effectiveSegments(title: string): string[] {
  return titleSegments(title).map(normalizeTitleForVariantMatch).filter((s) => s.length > 0);
}

function assertWellFormed(variants: Variant[]): void {
  for (const v of variants) {
    expect(v.raw).not.toBe('');
    expect(v.raw).toBe(v.raw.trim());
    expect(v.raw).toBe(v.raw.toLowerCase());
  }
  expect(new Set(variants.map((v) => v.raw)).size).toBe(variants.length);
}

describe('normalizeTitleForVariantMatch', () => {
  it('treats `:` as a separator instead of truncating', () => {
    expect(normalizeTitleForVariantMatch('Foo: A Tale of Two Cities')).toBe('foo a tale of two cities');
    expect(normalizeTitleForVariantMatch('Chapterhouse: Dune')).toBe('chapterhouse dune');
  });

  it('retains generic parenthetical/bracket text (that axis is derived, not scalar)', () => {
    expect(normalizeTitleForVariantMatch('Foundation (1951)')).toBe('foundation 1951');
    expect(normalizeTitleForVariantMatch('Foundation [1951]')).toBe('foundation 1951');
  });

  // Edition tails must fold on full forms; derived-only folds cannot pair asymmetrically.
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

// This suite covers generator segments; ladder admission stays in search-query-ladder tests.
describe('titleSegments', () => {
  it('splits the PAREN-STRIPPED base on qualifying colons, and its effective set is the count that matters', () => {
    const title = 'star wars: the high republic: Light of the Jedi (New Order Series)';
    expect(titleSegments(title)).toEqual(['star wars', ' the high republic', ' Light of the Jedi  ']);
    expect(effectiveSegments(title)).toEqual(['star wars', 'the high republic', 'light of the jedi']);
  });

  it('keeps punctuation-only segments raw — they are exactly what the effective set drops', () => {
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

  it('is NOT clamped — returns the full raw segment list past the generator cap (T12)', () => {
    const segments = titleSegments('ab: '.repeat(600));
    expect(segments).toHaveLength(300);
    expect(effectiveSegments('ab: '.repeat(600))).toHaveLength(300);
  });
});

/** Pins the export set; sort because Vite preserves source order while native ESM sorts keys. */
describe('public export surface (#2104 AC30)', () => {
  it('exports exactly the #2096 surface plus titleSegments', async () => {
    const ns = await import('./title-variants.js');
    // applyCommonFolds must remain private.
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

  // Assert only derived variants; the intact full must retain parenthetical text.
  it('never shears a colon that lives inside a parenthetical (AC2 / G1)', () => {
    const variants = titleVariants('The Spiral Path (World of Warcraft: Traveler, Book 2)');
    assertWellFormed(variants);

    const derived = variants.filter((v) => v.parensStripped);
    for (const v of derived) {
      expect(v.raw).not.toContain('world of warcraft');
    }
    expect(derived.map((v) => v.raw)).toEqual(['the spiral path']);
    expect(variants.filter((v) => v.raw.includes('world of warcraft'))).toEqual([
      { raw: 'the spiral path world of warcraft traveler book 2', tag: 'full', parensStripped: false, lossy: false },
    ]);
  });

  // Depth scanning must keep unbalanced or nested groups from leaking colons into derived forms.
  describe('balanced-agnostic paren stripping (#2109 AC1-AC3)', () => {
    const UNTERMINATED = 'The Spiral Path (World of Warcraft: Traveler, Book 2';
    const TERMINATED = 'The Spiral Path (World of Warcraft: Traveler, Book 2)';

    it('strips an unterminated group to end-of-string (T1)', () => {
      const variants = titleVariants(UNTERMINATED);
      assertWellFormed(variants);

      const derived = variants.filter((v) => v.parensStripped);
      expect(derived.map((v) => v.raw)).toEqual(['the spiral path']);
      expect(variants.filter((v) => v.raw.includes('world of warcraft'))).toEqual([
        { raw: 'the spiral path world of warcraft traveler book 2', tag: 'full', parensStripped: false, lossy: false },
      ]);
    });

    it('derives the same set from an unterminated group as from its balanced twin (T2)', () => {
      const strippedOf = (title: string): string[] =>
        titleVariants(title).filter((v) => v.parensStripped).map((v) => v.raw);
      expect(strippedOf(UNTERMINATED)).toEqual(strippedOf(TERMINATED));
      expect(strippedOf(UNTERMINATED)).toEqual(['the spiral path']);
    });

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

    it('does not fabricate a title from a nested group (T4)', () => {
      const variants = titleVariants('Dune (Deluxe (2nd) Edition: Annotated)');
      assertWellFormed(variants);

      expect(variants.some((v) => v.tag === 'prefix(1)' && v.raw === 'dune edition')).toBe(false);
      expect(variants.find((v) => v.parensStripped && v.tag === 'full')!.raw).toBe('dune');
      expect(variants.find((v) => v.tag === 'full' && !v.parensStripped)!.raw).toBe('dune deluxe 2nd edition annotated');
    });

    it.each([['Foo) Bar'], ['Foo] Bar']])('leaves a stray closer inert in %j (T5)', (title) => {
      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(variants.find((v) => v.tag === 'full')!.raw).toBe('foo bar');
    });

    it('strips an unterminated bracket group to end-of-string (T6)', () => {
      const variants = titleVariants('Foo [Bar: Baz');
      assertWellFormed(variants);
      expect(variants.some((v) => v.tag === 'prefix(1)' && v.raw === 'foo bar')).toBe(false);
      expect(variants.filter((v) => v.parensStripped).map((v) => v.raw)).toEqual(['foo']);
    });

    // A shared counter lets either closer end either opener; a kind-aware stack would return foo.
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

  it('emits a collapsed key exactly once, keeping the earliest tag', () => {
    const variants = titleVariants('Foo: Subtitle');
    assertWellFormed(variants);
    expect(variants).toEqual([
      { raw: 'foo subtitle', tag: 'full', parensStripped: false, lossy: false },
      { raw: 'foo', tag: 'prefix(1)', parensStripped: true, lossy: false },
      { raw: 'subtitle', tag: 'suffix(1)', parensStripped: true, lossy: false },
    ]);
    expect(variants.some((v) => v.tag === 'prefix(2)')).toBe(false);
  });

  it('does not strip leading articles', () => {
    expect(titleVariants('The Churn').map((v) => v.raw)).toEqual(['the churn']);
    expect(titleVariants('Churn').map((v) => v.raw)).toEqual(['churn']);
  });

  it('does not strip trailing volume markers', () => {
    const one = titleVariants('Saga Book 1');
    const two = titleVariants('Saga Book 2');
    expect(one.map((v) => v.raw)).toEqual(['saga book 1']);
    expect(two.map((v) => v.raw)).toEqual(['saga book 2']);
    expect(one.map((v) => v.raw)).not.toEqual(two.map((v) => v.raw));
  });

  // VariantTag permits arbitrary n; positive integers are a generator invariant.
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

  // lossy is computed from each raw slice before normalization and can block offered evidence.
  describe('per-variant lossy flag (#2110)', () => {
    it('flags the paren-stripped full of a Russian-edition-with-translation title', () => {
      // First-key dedup retains the lossy full, so the bare franchise prefix is not offered.
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
      // Sønner is lossy as a whole, but the offered suffix loses nothing.
      expect(titleVariants("Sønner: Assassin's Apprentice")).toEqual([
        { raw: "s nner assassin's apprentice", tag: 'full', parensStripped: false, lossy: true },
        { raw: 's nner', tag: 'prefix(1)', parensStripped: true, lossy: true },
        { raw: "assassin's apprentice", tag: 'suffix(1)', parensStripped: true, lossy: false },
      ]);
    });

    /** Covers ASCII, accented Latin, non-Latin, mixed-script, and out-of-band marks. */
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

    it('sets the parens-intact full variant flag to hasDegenerateFullForm(title)', () => {
      const withFull = mixedCorpus.filter((title) => normalizeTitleForVariantMatch(title).length > 0);
      expect(withFull.length).toBeGreaterThan(0);
      for (const title of withFull) {
        const full = titleVariants(title).find((v) => v.tag === 'full' && !v.parensStripped);
        expect(full).toBeDefined();
        expect(full!.lossy).toBe(hasDegenerateFullForm(title));
      }
    });

    // A non-degenerate whole cannot contain a lossy slice, making first-key dedup safe.
    it('emits no lossy variant for a title that is not degenerate as a whole', () => {
      const nonDegenerate = mixedCorpus.filter((title) => !hasDegenerateFullForm(title));
      expect(nonDegenerate.length).toBeGreaterThan(0);
      for (const title of nonDegenerate) {
        expect(titleVariants(title).filter((v) => v.lossy)).toEqual([]);
      }
    });
  });

  describe('input clamp (#2109 AC5/AC6)', () => {
    const derivedTagsOf = (title: string): string[] =>
      titleVariants(title).map((v) => v.tag).filter((tag) => tag !== 'full');

    it('exports the two caps as the thresholds under test', () => {
      expect(MAX_VARIANT_TITLE_LENGTH).toBe(2048);
      expect(MAX_VARIANT_SEGMENTS).toBe(32);
    });

    it('degrades on length alone, with the segment count well under its cap (T8)', () => {
      const title = 'x'.repeat(2300) + ': tail';
      expect(title.length).toBe(2306);
      expect(titleSegments(title)).toHaveLength(2);

      // Without a parenthetical, both full pushes dedupe.
      expect(titleVariants(title)).toEqual([
        { raw: `${'x'.repeat(2300)} tail`, tag: 'full', parensStripped: false, lossy: false },
      ]);
    });

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

    // Deluxe survives scalar normalization; Audio or Unabridged would collapse both full forms.
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

    // Assert bounded result shape instead of flaky timing; the old 64 KB path exceeded the timeout.
    it.each([[600], [6_000], [16_000]])('emits no derived variant for a %i-repeat colon-dense title (T17b)', (n) => {
      const title = 'ab: '.repeat(n);
      expect(title.length).toBeGreaterThan(MAX_VARIANT_TITLE_LENGTH);
      const variants = titleVariants(title);
      assertWellFormed(variants);
      expect(derivedTagsOf(title)).toEqual([]);
    });
  });
});

// Scalar folding can erase a title's only distinguishing text and leave a franchise prefix.
describe('hasDegenerateFullForm', () => {
  it('flags a title whose colon tail is erased by the ASCII fold (the live case)', () => {
    expect(normalizeTitleForVariantMatch('World of Warcraft: Перед бурей')).toBe('world of warcraft');
    expect(hasDegenerateFullForm('World of Warcraft: Перед бурей')).toBe(true);
  });

  it.each([
    ['World of Warcraft: 前夜'],
    ['Star Wars: Επεισόδιο'],
    // Non-decomposing Latin can erase an entire tail too.
    ['Star Wars: Æ'],
  ])('flags %j — any tail that leaves nothing behind', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(true);
  });

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

  // Partial token loss counts: A前夜 and A後夜 both scalar-fold to a.
  it.each([
    ['World of Warcraft: A前夜'],
    ['World of Warcraft: A後夜'],
    ['Star Wars: Episode1エピソード'],
  ])('flags %j — erased characters mixed INTO a surviving token', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(true);
  });

  it('flags a non-decomposing Latin letter, which the fold genuinely discards', () => {
    expect(normalizeTitleForVariantMatch('Straße')).toBe('stra e');
    expect(hasDegenerateFullForm('Straße')).toBe(true);
    expect(hasDegenerateFullForm('Straße: Beyond the Dark Portal')).toBe(true);
  });

  it.each([
    ['Chapterhouse: Dune'],
    ['World of Warcraft: Beyond the Dark Portal'],
    ['The Farseer: Assassin\'s Apprentice'],
    ['Foo: Subtitle'],
    ['Foundation'],
    ['Foundation (1951)'],
    ['IT: Chapter Two'],
    // A diacritic that folds to ASCII is not discarded.
    ['Star Wars: Éowyn'],
    ['Les Misérables'],
    // Apostrophes survive the scalar fold.
    ['Hitchhiker’s Guide'],
  ])('does not flag %j', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(false);
  });

  it('does not flag the colon-inside-parens fixture', () => {
    expect(hasDegenerateFullForm('The Spiral Path (World of Warcraft: Traveler, Book 2)')).toBe(false);
  });

  // Sạch proves in-band Latin marks still fold.
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

  /** U+1DC0 is outside scalar's strip band; lossless must preserve it so the loss stays visible. */
  it('flags an out-of-block combining mark on a Latin base (AC9)', () => {
    expect(normalizeTitleForVariantMatch('Sa᷀ga: Book One')).toBe('sa ga book one');
    expect(normalizeTitleLosslessly('Sa᷀ga: Book One')).toContain('᷀');
    expect(hasDegenerateFullForm('Sa᷀ga: Book One')).toBe(true);
  });

  it('does not flag a title that normalizes away entirely (the empty guard owns that)', () => {
    expect(hasDegenerateFullForm('[ ]')).toBe(false);
    expect(hasDegenerateFullForm('')).toBe(false);
    expect(hasDegenerateFullForm('Перед бурей')).toBe(false);
    expect(titleVariants('Перед бурей')).toEqual([]);
  });
});

describe('normalizeTitleLosslessly', () => {
  it('preserves every script while applying the same folds as the scalar form', () => {
    // Cyrillic й decomposes to и plus breve; stripping it would erase identity evidence.
    expect(normalizeTitleLosslessly('World of Warcraft: Перед бурей')).toBe('world of warcraft перед бурей');
    expect(normalizeTitleLosslessly('World of Warcraft: Последний страж')).toBe('world of warcraft последний страж');
    expect(normalizeTitleLosslessly('World of Warcraft')).toBe('world of warcraft');
  });

  it.each([
    ['World of Warcraft: май', 'World of Warcraft: маи', 'Cyrillic й is и + breve'],
    ['किताब', 'कितीब', 'Devanagari matra ी is identity-bearing'],
    ['סֵפֶר', 'ספר', 'Hebrew niqqud: pointed is not the unpointed spelling (D2)'],
    ['كِتاب', 'كتاب', 'Arabic harakat: pointed is not the unpointed spelling (D2)'],
  ])('refuses to fold %j onto %j — %s', (a, b) => {
    expect(normalizeTitleLosslessly(a)).not.toBe(normalizeTitleLosslessly(b));
  });

  it('does not fragment a word whose vowels are combining marks (AC4)', () => {
    expect(normalizeTitleLosslessly('किताब')).not.toContain(' ');
    expect(normalizeTitleLosslessly('किताब')).toBe('किताब');
  });

  // NFC is load-bearing: surviving marks must be independent of input normalization form.
  it.each([['World of Warcraft: Перед бурей'], ['किताब'], ['Les Misérables']])(
    'is independent of the input normalization form for %j (AC6)',
    (title) => {
      expect(normalizeTitleLosslessly(title.normalize('NFC'))).toBe(normalizeTitleLosslessly(title.normalize('NFD')));
    },
  );

  it('distinguishes titles the scalar form collapses together', () => {
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

  it('tolerates exactly the drift the scalar form tolerates — and no more', () => {
    expect(normalizeTitleLosslessly('  WORLD  of   Warcraft (Unabridged) ')).toBe('world of warcraft');
    expect(normalizeTitleLosslessly('Cake & Puppets')).toBe('cake and puppets');
    expect(normalizeTitleLosslessly('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
    expect(normalizeTitleLosslessly('Les Misérables')).toBe('les miserables');
    expect(normalizeTitleLosslessly('Café')).toBe('cafe');
    expect(normalizeTitleLosslessly('Перед бурей')).toBe('перед бурей');
  });
});

/**
 * Shared mechanics do not prove scalar/lossless lockstep because their strip and keep knobs differ.
 * Across every fold trigger, ASCII-folding lossless output must equal scalar output. Sa᷀ga ensures
 * widening the lossless strip beyond U+0300–036F breaks the property.
 */
describe('scalar/lossless fold lockstep (#2109 AC9)', () => {
  const asciiFold = (s: string): string => s.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Literal characters make the file encoding part of the fixture contract.
  const lockstepCorpus = [
    // ASCII punctuation and threshold shapes.
    'Chapterhouse: Dune',
    'The Churn: An Expanse Novella',
    'star wars: the high republic: Light of the Jedi (New Order Series)',
    'IT: Chapter Two',
    'Foundation (1951)',
    'Foundation [1951]',
    'Saga Book 1',
    // Foldable Latin accents.
    'Café: A Novel',
    'Les Misérables: Tome I',
    'García: Un Cuento',
    // Non-decomposing Latin.
    'Straße: Beyond the Dark Portal',
    'Sønner: Assassin\'s Apprentice',
    'Star Wars: Æ',
    // Non-Latin scripts that only lossless may retain.
    'World of Warcraft: Перед бурей',
    'World of Warcraft: май',
    'World of Warcraft: маи',
    'Star Wars: Επεισόδιο',
    'Star Wars: 前夜Thrawn',
    'A前夜',
    'World of Warcraft: A前夜',
    'World of Warcraft: A後夜',
    'किताब',
    'कितीब: Part Two',
    'סֵפֶר',
    'ספר',
    'كِتاب',
    'كتاب',
    'Sạch: Vietnamese Tone Marks',
    // Out-of-band mark: the strip-widening mutation's observation point.
    'Sa᷀ga: Book One',
    // Remaining fold triggers.
    'Night of Cake & Puppets',
    'Cake + Puppets',
    'Hitchhiker’s Guide',
    '  WORLD  of   Warcraft (Unabridged) ',
    'Foo [Audible]',
    // Empty inputs.
    '',
    '   ',
    '[ ]',
  ];

  it('folds the lossless form onto the scalar form for every title in the corpus (T14/T15)', () => {
    expect(lockstepCorpus.length).toBeGreaterThan(30);
    for (const title of lockstepCorpus) {
      expect(asciiFold(normalizeTitleLosslessly(title)), `lockstep broke on ${JSON.stringify(title)}`)
        .toBe(normalizeTitleForVariantMatch(title));
    }
  });

  // Pin the mutation fixture separately so corpus edits cannot erase its observation point.
  it('covers the out-of-block combining mark the AC10 mutation moves (T15)', () => {
    expect(lockstepCorpus).toContain('Sa᷀ga: Book One');
    expect(normalizeTitleForVariantMatch('Sa᷀ga: Book One')).toBe('sa ga book one');
    expect(asciiFold(normalizeTitleLosslessly('Sa᷀ga: Book One'))).toBe('sa ga book one');
  });
});
