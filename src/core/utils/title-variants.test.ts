import { describe, it, expect } from 'vitest';
import { titleVariants, normalizeTitleForVariantMatch, hasDegenerateFullForm, normalizeTitleLosslessly } from './title-variants.js';
import type { Variant } from './title-variants.js';

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

describe('titleVariants', () => {
  // AC5 — the full worked array. Pins membership, tags, `parensStripped` flags
  // and the G4 total order end to end in one assertion.
  it('emits the full ordered array for a deep-franchise title (AC5)', () => {
    expect(titleVariants('star wars: the high republic: Light of the Jedi (New Order Series)')).toEqual([
      { raw: 'star wars the high republic light of the jedi new order series', tag: 'full', parensStripped: false },
      { raw: 'star wars the high republic light of the jedi', tag: 'full', parensStripped: true },
      { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true },
      { raw: 'the high republic light of the jedi', tag: 'suffix(2)', parensStripped: true },
      { raw: 'star wars light of the jedi', tag: 'first+last', parensStripped: true },
      { raw: 'star wars', tag: 'prefix(1)', parensStripped: true },
      { raw: 'light of the jedi', tag: 'suffix(1)', parensStripped: true },
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
      { raw: 'the spiral path world of warcraft traveler book 2', tag: 'full', parensStripped: false },
    ]);
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
      expect(variants).toEqual([{ raw: expectedFull, tag: 'full', parensStripped: false }]);
    });

    it('segments `A B: C` — internal whitespace counts toward the 3-char left context', () => {
      expect(titleVariants('A B: C')).toEqual([
        { raw: 'a b c', tag: 'full', parensStripped: false },
        { raw: 'a b', tag: 'prefix(1)', parensStripped: true },
        { raw: 'c', tag: 'suffix(1)', parensStripped: true },
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
      expect(titleVariants('a::b')).toEqual([{ raw: 'a b', tag: 'full', parensStripped: false }]);
    });
  });

  // G2/G4 — `prefix(k)`/`suffix(k)` at k === segment count collapse onto the
  // paren-stripped full and the dedup pass keeps the FIRST occurrence.
  it('emits a collapsed key exactly once, keeping the earliest tag', () => {
    const variants = titleVariants('Foo: Subtitle');
    assertWellFormed(variants);
    expect(variants).toEqual([
      { raw: 'foo subtitle', tag: 'full', parensStripped: false },
      { raw: 'foo', tag: 'prefix(1)', parensStripped: true },
      { raw: 'subtitle', tag: 'suffix(1)', parensStripped: true },
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

  it.each([
    // A surviving tail is the whole point — these are real, complete titles.
    ['Chapterhouse: Dune'],
    ['World of Warcraft: Beyond the Dark Portal'],
    ['The Farseer: Assassin\'s Apprentice'],
    ['Foo: Subtitle'],
    // No qualifying colon boundary at all: a bare title is never degenerate,
    // otherwise "Foundation" could not pair with "Foundation (1951)".
    ['Foundation'],
    ['Foundation (1951)'],
    ['IT: Chapter Two'],
    // A diacritic that FOLDS is not a token that vanished.
    ['Star Wars: Éowyn'],
    ['Les Misérables'],
    // A token that FRAGMENTS survives as mangled text, not as nothing:
    // 'straße' -> 'stra e' (#1547 pins that ß is not transliterated).
    ['Straße'],
    ['Straße: Beyond the Dark Portal'],
  ])('does not flag %j', (title) => {
    expect(hasDegenerateFullForm(title)).toBe(false);
  });

  // F8 named requirement: the colon-inside-parentheses case must stay green —
  // its parenthetical is retained by the scalar form and every token survives.
  it('does not flag the colon-inside-parens fixture', () => {
    expect(hasDegenerateFullForm('The Spiral Path (World of Warcraft: Traveler, Book 2)')).toBe(false);
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
    // NOTE the trailing `и`: the combining-diacritic fold is script-agnostic, so
    // Cyrillic `й` decomposes to `и` + breve and loses the breve exactly as `é`
    // loses its acute. That is the intended behaviour — one consistent fold — and
    // it costs nothing here, because the surviving letters still tell the two
    // subtitles apart, which is all this form is used for.
    expect(normalizeTitleLosslessly('World of Warcraft: Перед бурей')).toBe('world of warcraft перед буреи');
    expect(normalizeTitleLosslessly('World of Warcraft: Последний страж')).toBe('world of warcraft последнии страж');
    expect(normalizeTitleLosslessly('World of Warcraft')).toBe('world of warcraft');
  });

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

  it('tolerates exactly the drift the scalar form tolerates — and no more', () => {
    expect(normalizeTitleLosslessly('  WORLD  of   Warcraft (Unabridged) ')).toBe('world of warcraft');
    expect(normalizeTitleLosslessly('Cake & Puppets')).toBe('cake and puppets');
    expect(normalizeTitleLosslessly('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
    expect(normalizeTitleLosslessly('Les Misérables')).toBe('les miserables');
    // But it does NOT erase a non-Latin script, which is the whole point.
    expect(normalizeTitleLosslessly('Перед бурей')).toBe('перед буреи');
  });
});
