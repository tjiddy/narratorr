import { describe, it, expect, vi } from 'vitest';
import {
  explainTitlePairing,
  findInLibraryMatch,
  normalizeMemberTitleForMatch,
  VARIANT_CACHE_MAX,
} from './series-title-match.js';
import { titleVariants, hasDegenerateFullForm, normalizeTitleLosslessly } from '@core/utils/title-variants.js';
import type { TitlePairArm } from '@shared/schemas/series-title-variants.js';

// Spy-wrap the REAL generator so derivation counts are observable. A cache hit
// and a cache miss return equal values, so the memo's two branches cannot be
// seen through pairing results at all — only through how often the generator
// actually ran. Behaviour is unchanged: the mock delegates to the real
// implementation, and the module's other exports pass through untouched (the
// matcher re-exports `normalizeTitleForVariantMatch` from here).
vi.mock('@core/utils/title-variants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/title-variants.js')>();
  return { ...actual, titleVariants: vi.fn(actual.titleVariants) };
});

describe('normalizeMemberTitleForMatch', () => {
  it('case-folds, drops punctuation, collapses whitespace', () => {
    expect(normalizeMemberTitleForMatch('The Wind Through the Keyhole')).toBe('the wind through the keyhole');
    expect(normalizeMemberTitleForMatch('The Wind through the Keyhole')).toBe('the wind through the keyhole');
  });

  // #2096: the colon is a SEPARATOR, not a truncation point. The pre-#2096
  // normalizer returned 'foo' here, which keyed "Chapterhouse: Dune" to
  // `chapterhouse` and lost the pairing with a library "Chapterhouse Dune".
  it('treats `:` as a separator instead of truncating the subtitle', () => {
    expect(normalizeMemberTitleForMatch('Foo: A Tale of Two Cities')).toBe('foo a tale of two cities');
    expect(normalizeMemberTitleForMatch('Chapterhouse: Dune')).toBe('chapterhouse dune');
  });

  // #2096: the generic paren/bracket strip moved to the DERIVED variant axis,
  // so the scalar form retains the annotation text.
  it('retains generic parenthetical/bracket text', () => {
    expect(normalizeMemberTitleForMatch('Foundation (1951)')).toBe('foundation 1951');
    expect(normalizeMemberTitleForMatch('Foundation [1951]')).toBe('foundation 1951');
  });

  // AC7 — the edition strip is load-bearing HERE, in the scalar normalizer.
  // Demote it to the derived axis and 'Foo (Audio)' ≡ 'Foo (Unabridged)' below
  // regresses: both sides become DERIVED forms, which the asymmetric rule
  // forbids from pairing. Asserting the scalar values directly means that
  // refactor fails on THIS assertion rather than mysteriously on the pairing one.
  it('strips Unabridged / Audio / Audible edition tails in the scalar form', () => {
    expect(normalizeMemberTitleForMatch('Foo (Unabridged)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audio)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audible)')).toBe('foo');
  });

  it('normalizes curly apostrophes to straight', () => {
    expect(normalizeMemberTitleForMatch('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
  });

  // #1543: `&` and the word `and` must normalize identically — the `&` form
  // was previously dropped to nothing, so it never matched the spelled-out form.
  it('canonicalizes `&` to the word `and` so both spellings converge', () => {
    expect(normalizeMemberTitleForMatch('Night of Cake & Puppets')).toBe('night of cake and puppets');
    expect(normalizeMemberTitleForMatch('Night of Cake and Puppets')).toBe('night of cake and puppets');
    expect(normalizeMemberTitleForMatch('Night of Cake & Puppets')).toBe(
      normalizeMemberTitleForMatch('Night of Cake and Puppets'),
    );
  });

  it('treats `+` the same as `&`, collapsing surrounding whitespace', () => {
    expect(normalizeMemberTitleForMatch('Cake + Puppets')).toBe('cake and puppets');
  });

  // #1547: accented chars were dropped to a space by the alnum strip, so the
  // accented and ASCII spellings of a title never converged. Folding combining
  // diacritics to their base letter (NFD) before the strip keeps the letter.
  it('folds combining diacritics so accented and ASCII spellings converge', () => {
    // Assert the concrete value so a *drop* ('les mis rables') regression is caught, not just equality.
    expect(normalizeMemberTitleForMatch('Les Misérables')).toBe('les miserables');
    expect(normalizeMemberTitleForMatch('Les Miserables')).toBe('les miserables');
    expect(normalizeMemberTitleForMatch('Les Misérables')).toBe(normalizeMemberTitleForMatch('Les Miserables'));
  });

  it('folds common author/title accents (ñ, ë) to base letters', () => {
    expect(normalizeMemberTitleForMatch('García')).toBe('garcia');
    expect(normalizeMemberTitleForMatch('Brontë')).toBe('bronte');
  });

  it('leaves plain-ASCII titles unchanged (no diacritic regression)', () => {
    expect(normalizeMemberTitleForMatch('The Wind Through the Keyhole')).toBe('the wind through the keyhole');
  });

  // #1547 scope pin: the fold is NFD-only — non-decomposing letters (ß / ø / æ)
  // are intentionally NOT folded (no transliteration). They have no combining
  // marks, so the alnum strip drops them as before.
  it('does NOT fold non-decomposing letters (ß is not transliterated to ss)', () => {
    const out = normalizeMemberTitleForMatch('Straße');
    expect(out).not.toBe('strasse');
    expect(out).toBe('stra e');
  });
});

/**
 * An INDEPENDENT re-derivation of the acceptance rule, built from the core pure
 * functions rather than from `explainShapePairing` — so that when the two
 * disagree, the rule has drifted from its model and the corpus says so.
 *
 * It models all EIGHT ordered rows of the rule. Before #2110 it modelled only
 * rows 3, 4 and 7 and had never modelled the degeneracy contracts at all; the
 * corpus agreed with production only because every corpus row was
 * non-degenerate. **Update this whenever the rule's rows change** — that is the
 * entire point of it existing separately.
 *
 * FULL is `{ tag: 'full', parensStripped: false }`, which is the scalar
 * normalized form by construction.
 */
function pairingArm(a: string, b: string): TitlePairArm {
  const aFull = normalizeMemberTitleForMatch(a);
  const bFull = normalizeMemberTitleForMatch(b);
  const aLossless = normalizeTitleLosslessly(a);
  const bLossless = normalizeTitleLosslessly(b);

  // Rows 1-2: both FULL forms empty.
  if (aFull.length === 0 && bFull.length === 0) {
    return aLossless.length > 0 && aLossless === bLossless ? 'lossless-equals-lossless' : 'none';
  }
  // Row 3: exactly one FULL form empty.
  if (aFull.length === 0 || bFull.length === 0) return 'none';
  // Rows 4-6: FULL forms equal.
  if (aFull === bFull) {
    if (!hasDegenerateFullForm(a) && !hasDegenerateFullForm(b)) return 'full-equals-full';
    return aLossless === bLossless ? 'full-equals-full' : 'none';
  }
  // Rows 7-8: a non-lossy derived variant reaching a non-degenerate FULL form.
  const derived = (title: string): string[] =>
    titleVariants(title)
      .filter((v) => (v.tag !== 'full' || v.parensStripped) && !v.lossy)
      .map((v) => v.raw);
  if (!hasDegenerateFullForm(b) && derived(a).includes(bFull)) return 'derived-equals-full';
  if (!hasDegenerateFullForm(a) && derived(b).includes(aFull)) return 'derived-equals-full';
  return 'none';
}

/** Pair two titles through the real matcher, in the given argument order, positions absent. */
function pairsOneWay(memberTitle: string, bookTitle: string): boolean {
  return findInLibraryMatch(
    { title: memberTitle, position: null },
    [{ id: 1, title: bookTitle, seriesPosition: null }],
  ) !== null;
}

/** The `bothWays` idiom from `dedup.test.ts` — the relation must be symmetric. */
function pairsBothWays(a: string, b: string): boolean {
  const forward = pairsOneWay(a, b);
  expect(pairsOneWay(b, a)).toBe(forward);
  return forward;
}

describe('title-variant pairing (#2096 fixture corpus)', () => {
  const corpus: Array<{ a: string; b: string; matches: boolean; arm: TitlePairArm }> = [
    // The live prod case: the colon truncation keyed the member to `chapterhouse`.
    { a: 'Chapterhouse: Dune', b: 'Chapterhouse Dune', matches: true, arm: 'full-equals-full' },
    // Franchise-FIRST: the library owns the sub-title alone.
    { a: "The Farseer: Assassin's Apprentice", b: "Assassin's Apprentice", matches: true, arm: 'derived-equals-full' },
    // Title-FIRST subtitle: the library owns the prefix. Must keep matching.
    { a: 'The Churn: An Expanse Novella', b: 'The Churn', matches: true, arm: 'derived-equals-full' },
    { a: 'Foo: Subtitle', b: 'Foo', matches: true, arm: 'derived-equals-full' },
    // Asymmetric-rule negatives — derived≡derived is never a match.
    { a: 'Series: A', b: 'Series: B', matches: false, arm: 'none' },
    { a: 'Foo: A Novel', b: 'Bar: A Novel', matches: false, arm: 'none' },
    { a: 'Star Wars: A', b: 'Star Wars: B', matches: false, arm: 'none' },
    // Paren axis: the parens-stripped full is derived, the bare title is FULL.
    { a: 'Star Wars: The Rising Storm (The High Republic)', b: 'Star Wars: The Rising Storm', matches: true, arm: 'derived-equals-full' },
    // Colon INSIDE parens — the ordering rule keeps `world of warcraft` out of
    // every derived variant, so this must NOT pair on a sheared prefix.
    { a: 'The Spiral Path (World of Warcraft: Traveler, Book 2)', b: 'The Spiral Path World of Warcraft', matches: false, arm: 'none' },
    // The deep-franchise case `first+last` exists for.
    { a: 'star wars: the high republic: Light of the Jedi (New Order Series)', b: 'Star Wars: Light of the Jedi', matches: true, arm: 'derived-equals-full' },
    // AC18: the #1896 volume-marker collapse is NOT propagated here.
    { a: 'Saga Book 1', b: 'Saga Book 2', matches: false, arm: 'none' },

    // ---- #2110: rows the pre-#2110 `pairingArm` could not reach at all. ----
    // Row 6 — FULLs equal, a side degenerate, lossless forms differ.
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft: Последний страж', matches: false, arm: 'none' },
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft', matches: false, arm: 'none' },
    // Row 5 — FULLs equal, a side degenerate, lossless forms agree.
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft: Перед бурей', matches: true, arm: 'full-equals-full' },
    // Row 7 — a degenerate side may still OFFER a fragment that lost nothing.
    { a: "Sønner: Assassin's Apprentice", b: "Assassin's Apprentice", matches: true, arm: 'derived-equals-full' },
    // Row 8 — the offered fragment is itself lossy, so it is not evidence.
    { a: 'Star Wars: 前夜Thrawn', b: 'Thrawn', matches: false, arm: 'none' },
    // Row 7 — its non-lossy sibling fragment still pairs. Deliberately BOTH, so
    // the lossy filter is pinned as a filter and not as a blanket refusal.
    { a: 'Star Wars: 前夜Thrawn', b: 'Star Wars', matches: true, arm: 'derived-equals-full' },
    // Row 1 — the narrow non-Latin identity arm.
    { a: 'Перед бурей', b: 'Перед бурей', matches: true, arm: 'lossless-equals-lossless' },
    // Row 2 — both FULL forms empty, lossless forms differ.
    { a: 'Перед бурей', b: 'Последний страж', matches: false, arm: 'none' },
    // Row 2 again, and the reason there is no non-Latin fragment path: EVERY
    // character of `'Дюна: Капитул'` is Cyrillic, so its FULL form is empty too.
    { a: 'Дюна: Капитул', b: 'Капитул', matches: false, arm: 'none' },
    // Row 3 — exactly one FULL form empty. This is the case the loosened G5
    // guard newly REACHES, and it must still refuse.
    { a: 'Перед бурей', b: 'Anything', matches: false, arm: 'none' },
  ];

  // The live AC17 sweep found this class: the ASCII fold erases a non-Latin
  // subtitle, so the member's FULL form degenerates to a bare franchise prefix
  // and legally pairs with every sibling's `prefix(1)`. A degenerate FULL may not
  // serve as the FULL side of the derived arm.
  describe('degenerate full forms (AC17 live finding)', () => {
    it('refuses the live case: an erased-subtitle member claiming a franchise sibling', () => {
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft: Beyond the Dark Portal')).toBe(false);
    });

    it('refuses it against every sibling, not just the one it happened to claim', () => {
      const siblings = [
        'World of Warcraft: Beyond the Dark Portal',
        'World of Warcraft: Traveler',
        'World of Warcraft: Illidan',
      ];
      const candidates = siblings.map((title, i) => ({ id: i + 1, title, seriesPosition: null }));
      expect(findInLibraryMatch({ title: 'World of Warcraft: Перед бурей', position: null }, candidates)).toBeNull();
    });

    // F8 — the erased tail can sit anywhere. Each of these has FULL form exactly
    // `world of warcraft`, and each must be refused against a franchise sibling.
    it.each([
      ['World of Warcraft: (Перед бурей)', 'parenthesised after a colon'],
      ['World of Warcraft: [Перед бурей]', 'bracketed after a colon'],
      ['World of Warcraft (Перед бурей)', 'parenthesised with NO colon'],
      ['World of Warcraft [Перед бурей]', 'bracketed with NO colon'],
      ['Перед бурей: World of Warcraft', 'erased content LEADING the surviving text'],
    ])('refuses %j (%s) against a franchise sibling', (member) => {
      expect(normalizeMemberTitleForMatch(member)).toBe('world of warcraft');
      expect(pairsBothWays(member, 'World of Warcraft: Beyond the Dark Portal')).toBe(false);
    });

    // F7 — the FULL≡FULL arm was the remaining bypass: these all collapse to the
    // same `world of warcraft` scalar form, so equal FULL forms alone are not
    // evidence of equal titles when either side is degenerate.
    it('refuses two DISTINCT erased-tail titles that collapse to the same FULL form', () => {
      expect(normalizeMemberTitleForMatch('World of Warcraft: Перед бурей')).toBe('world of warcraft');
      expect(normalizeMemberTitleForMatch('World of Warcraft: Последний страж')).toBe('world of warcraft');
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft: Последний страж')).toBe(false);
    });

    it('refuses an erased-tail title against a genuinely bare franchise title', () => {
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft')).toBe(false);
    });

    it('still pairs the SAME non-Latin title with itself (the true positive)', () => {
      // The guard demands non-lossy identity evidence, not abstinence: two copies
      // of the same book still pair, and tolerate the usual case/spacing drift.
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft: Перед бурей')).toBe(true);
      expect(pairsBothWays('World of Warcraft: Перед бурей', '  world of WARCRAFT:  Перед  бурей (Unabridged)')).toBe(true);
    });

    it('still pairs two books that agree on their WHOLE normalized text', () => {
      // Two NON-degenerate sides take the ordinary FULL≡FULL path untouched.
      expect(pairsBothWays('World of Warcraft', 'World of Warcraft')).toBe(true);
    });

    // F10 — erased characters MIXED INTO a surviving token. Both of these reduce
    // to `world of warcraft a`, so the FULL≡FULL arm sees identical forms; only
    // the lossless comparison can tell the two books apart.
    it('refuses two DISTINCT mixed-token titles that collapse to the same FULL form', () => {
      expect(normalizeMemberTitleForMatch('World of Warcraft: A前夜')).toBe('world of warcraft a');
      expect(normalizeMemberTitleForMatch('World of Warcraft: A後夜')).toBe('world of warcraft a');
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft: A後夜')).toBe(false);
    });

    it('refuses a mixed-token title against the bare title its FULL form collides with', () => {
      // 'World of Warcraft A' is a different book that happens to normalize to
      // the same scalar text once 前夜 is discarded.
      expect(normalizeMemberTitleForMatch('World of Warcraft A')).toBe('world of warcraft a');
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft A')).toBe(false);
    });

    it('still pairs the SAME mixed-token title with itself', () => {
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft: A前夜')).toBe(true);
    });

    // Scope pin for the guard: degeneracy disqualifies a title from being the
    // trusted COMPLETE side, NOT from offering a fragment to one. Gating this
    // would break the AC11 fixture `'Foo: Subtitle' ≡ 'Foo'`, whose shape it
    // shares exactly.
    it('lets a degenerate title still OFFER a fragment to a non-degenerate FULL side', () => {
      expect(hasDegenerateFullForm("Sønner: Assassin's Apprentice")).toBe(true);
      expect(pairsBothWays("Sønner: Assassin's Apprentice", "Assassin's Apprentice")).toBe(true);
      // The pinned fixture this preserves, and its all-ASCII franchise twin.
      expect(pairsBothWays('Foo: Subtitle', 'Foo')).toBe(true);
      expect(pairsBothWays('World of Warcraft: Beyond the Dark Portal', 'World of Warcraft')).toBe(true);
      // #2110: a lossy fragment is refused, a non-lossy one from the SAME
      // degenerate title is not. Both, deliberately — the flag is a filter on
      // fragments, not a blanket refusal of degenerate offerers.
      expect(pairsBothWays('Star Wars: 前夜Thrawn', 'Star Wars')).toBe(true);
    });

    /**
     * #2110 gap 1 — the OFFERING side's fragments were never checked for
     * character survival, only the target's FULL form was. Both arms trusted a
     * fragment whose own distinguishing characters the fold had eaten, which is
     * the franchise cross-match class re-entering one level down.
     */
    describe('lossy derived fragments are not evidence (#2110)', () => {
      it('refuses a Russian-edition-with-translation title claiming the bare franchise', () => {
        // The paren-stripped full reduces to exactly `world of warcraft`, and
        // the non-lossy `prefix(1)` that would carry the same text is shadowed
        // by it under first-wins dedup — so nothing non-lossy is offered.
        expect(titleVariants('World of Warcraft: Тревелер (Traveler)').every((v) => v.lossy)).toBe(true);
        expect(pairsBothWays('World of Warcraft: Тревелер (Traveler)', 'World of Warcraft')).toBe(false);
      });

      it('refuses a CJK-prefixed subtitle claiming the library book its suffix collides with', () => {
        const suffix = titleVariants('Star Wars: 前夜Thrawn').find((v) => v.tag === 'suffix(1)');
        expect(suffix).toMatchObject({ raw: 'thrawn', lossy: true });
        expect(pairsBothWays('Star Wars: 前夜Thrawn', 'Thrawn')).toBe(false);
      });
    });

    it('leaves a non-degenerate franchise title able to serve as the FULL side', () => {
      // The guard must not disarm the real derived arm: this is the deep-franchise
      // `first+last` case, whose FULL side keeps its distinguishing tail.
      expect(pairsBothWays(
        'star wars: the high republic: Light of the Jedi (New Order Series)',
        'Star Wars: Light of the Jedi',
      )).toBe(true);
    });

    it('still rescues an erased-subtitle member by POSITION', () => {
      // The guard gates one arm of the title path only — it must not make the
      // member unmatchable, exactly as the empty-variant guard does not (G5).
      const candidates = [{ id: 1, title: 'World of Warcraft: Beyond the Dark Portal', seriesPosition: 15 }];
      expect(findInLibraryMatch({ title: 'World of Warcraft: Перед бурей', position: 15 }, candidates)?.id).toBe(1);
    });
  });

  /**
   * THREE assertions, each observing a different thing (#2110 AC38):
   *  - `pairsBothWays` — what the real matcher does.
   *  - `pairingArm` — the independent re-derivation. Disagreement with the first
   *    means the rule drifted from its model.
   *  - `explainTitlePairing(...).arm` — production's OWN classification.
   *    Disagreement with the second means `arm` is mislabelled, which is
   *    invisible to any boolean assertion.
   */
  it.each(corpus)('$a ↔ $b → $matches via $arm', ({ a, b, matches, arm }) => {
    expect(pairsBothWays(a, b)).toBe(matches);
    expect(pairingArm(a, b)).toBe(arm);
    expect(explainTitlePairing(a, b).arm).toBe(arm);
  });

  /**
   * #2110 AC18/AC19 — the rule's structural properties, as properties rather
   * than as one restatement per corpus row.
   */
  describe('rule properties (#2110)', () => {
    const probes = [...new Set([
      ...corpus.flatMap(({ a, b }) => [a, b]),
      'World of Warcraft: A前夜',
      'Sa᷀ga: Book One',
      'Straße: Beyond the Dark Portal',
      // AC19's boundary table — every one of these is a case where a
      // raw-character reading of the reflexivity domain gets the answer wrong.
      '&',
      '+',
      '’',
      "'",
      '(Audio)',
      '[Audible]',
      '(Unabridged)',
      '[ ]',
      '   ',
    ])];
    const pairs: Array<[string, string]> = probes.flatMap((a) => probes.map((b): [string, string] => [a, b]));

    it('pairs === (arm !== "none") for every pair', () => {
      for (const [a, b] of pairs) {
        const verdict = explainTitlePairing(a, b);
        expect(verdict.pairs).toBe(verdict.arm !== 'none');
      }
    });

    it('is symmetric in both `pairs` and `arm` for every pair', () => {
      for (const [a, b] of pairs) {
        const forward = explainTitlePairing(a, b);
        const backward = explainTitlePairing(b, a);
        expect(backward.pairs).toBe(forward.pairs);
        expect(backward.arm).toBe(forward.arm);
      }
    });

    /**
     * Reflexivity holds EXACTLY on `normalizeTitleLosslessly(t) !== ''`, and
     * that predicate is the only normative form of the domain. Do NOT restate
     * it as a test over the raw input's characters: the fold TRANSFORMS before
     * it applies its keep class, so a raw-character shorthand is wrong in both
     * directions — `'&'` carries no letter yet folds to `and`, and `'(Audio)'`
     * carries five yet folds to `''`.
     *
     * The filter therefore calls the normalizer, never a hand-written class.
     */
    it('is reflexive exactly where the lossless form is non-empty', () => {
      const inDomain = probes.filter((t) => normalizeTitleLosslessly(t) !== '');
      expect(inDomain.length).toBeGreaterThan(0);
      for (const t of inDomain) expect(explainTitlePairing(t, t).pairs).toBe(true);
    });

    /**
     * Outside the domain a self-pair is REFUSED, and that is required rather
     * than tolerated: it is the same refusal that stops two DIFFERENT untitled
     * members claiming each other's books (AC24). "Fixing" it would violate
     * row 2.
     */
    it('refuses a self-pair outside the domain', () => {
      const outOfDomain = probes.filter((t) => normalizeTitleLosslessly(t) === '');
      expect(outOfDomain.length).toBeGreaterThan(0);
      for (const t of outOfDomain) {
        expect(explainTitlePairing(t, t)).toMatchObject({ pairs: false, arm: 'none' });
      }
    });

    /**
     * Every row of AC19's boundary table, self-paired, pinned individually.
     * These are the ONLY cases that can catch a hand-rolled character-class
     * filter — the `'[ ]'` case alone cannot, since both readings agree on it.
     */
    it.each([
      // No letter, digit, mark or apostrophe in the input, yet `&`/`+` → "and"
      // creates one.
      ['&', 'and', 'full-equals-full'],
      ['+', 'and', 'full-equals-full'],
      // Folded to the straight form BEFORE the keep class, so it survives
      // despite not being the listed straight `'`.
      ['’', "'", 'full-equals-full'],
      ["'", "'", 'full-equals-full'],
      // Carries letters, but the edition-tail strip removes the whole string.
      ['(Audio)', '', 'none'],
      ['[Audible]', '', 'none'],
      ['(Unabridged)', '', 'none'],
      // Nothing survives either fold.
      ['[ ]', '', 'none'],
      ['   ', '', 'none'],
      // Zero variants and an empty scalar FULL, but non-empty identity
      // evidence — the domain is not "has variants" either.
      ['Перед бурей', 'перед бурей', 'lossless-equals-lossless'],
    ])('self-pairs %j (lossless %j) via arm %s', (title, lossless, arm) => {
      expect(normalizeTitleLosslessly(title)).toBe(lossless);
      expect(explainTitlePairing(title, title)).toMatchObject({ pairs: arm !== 'none', arm });
    });
  });
});

/**
 * #2110 — the narrow non-Latin identity arm. An all-non-Latin title scalar-folds
 * to empty and yields ZERO variants, so before this arm two IDENTICAL non-Latin
 * titles never title-paired at all (position rescue only) — leaving the original
 * Chapterhouse symptom, a wrong '+Add' on an owned book, fully intact for
 * non-Latin libraries.
 */
describe('non-Latin identity arm (#2110)', () => {
  it('pairs two identical non-Latin titles', () => {
    expect(titleVariants('Перед бурей')).toEqual([]);
    expect(normalizeMemberTitleForMatch('Перед бурей')).toBe('');
    expect(pairsBothWays('Перед бурей', 'Перед бурей')).toBe(true);
  });

  it('tolerates the same drift every other arm tolerates', () => {
    expect(pairsBothWays('Перед бурей', '  перед  БУРЕЙ (Unabridged)')).toBe(true);
  });

  // AC23 — the original Chapterhouse symptom (`:` truncation vs separator),
  // closed for non-Latin.
  it('pairs across a colon the way the scalar form does for Latin titles', () => {
    expect(pairsBothWays('Перед: бурей', 'Перед бурей')).toBe(true);
  });

  it('refuses two DIFFERENT non-Latin titles', () => {
    expect(pairsBothWays('Перед бурей', 'Последний страж')).toBe(false);
  });

  /**
   * AC25 — the arm does NOT widen the derived path, and both refusals matter:
   *  - `'Дюна: Капитул'` vs `'Капитул'`: every character is Cyrillic, so BOTH
   *    scalar FULL forms are empty and row 2 fires on unequal lossless forms.
   *    There is no non-Latin fragment-to-FULL path at all.
   *  - `'Перед бурей'` vs `'Anything'`: exactly one FULL form is empty, so row 3
   *    fires — the case the loosened G5 guard newly reaches.
   */
  it('offers no non-Latin fragment-to-FULL path', () => {
    expect(normalizeMemberTitleForMatch('Дюна: Капитул')).toBe('');
    expect(normalizeMemberTitleForMatch('Капитул')).toBe('');
    expect(pairsBothWays('Дюна: Капитул', 'Капитул')).toBe(false);
  });

  it('refuses a non-Latin title against an unrelated Latin one', () => {
    expect(pairsBothWays('Перед бурей', 'Anything')).toBe(false);
  });

  /**
   * BOTH edits are load-bearing, and this records why the pairing rule alone is
   * not enough — the same reasoning as the "decisive G5 pair" above.
   * Counterfactual (run, verified): revert `findInLibraryMatch`'s guard to
   * `variants.length === 0` and every assertion in this describe that goes
   * through the matcher fails, while `explainTitlePairing` keeps returning
   * `lossless-equals-lossless`. The guard sits BEFORE any candidate is
   * compared, so a rule-only change is inert.
   */
  it('reaches the matcher, not just the rule', () => {
    expect(explainTitlePairing('Перед бурей', 'Перед бурей').arm).toBe('lossless-equals-lossless');
    expect(pairsOneWay('Перед бурей', 'Перед бурей')).toBe(true);
  });
});

describe('findInLibraryMatch', () => {
  it('matches on exact position equality', () => {
    const candidates = [{ id: 1, title: 'Some Title', seriesPosition: 2 }];
    const match = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates);
    expect(match?.id).toBe(1);
  });

  it('matches on title equality when positions disagree (Dark Tower pattern)', () => {
    // Library: pos=8 The Wind Through the Keyhole
    // Hardcover: pos=4.5 The Wind through the Keyhole
    const candidates = [{ id: 1, title: 'The Wind Through the Keyhole', seriesPosition: 8 }];
    const match = findInLibraryMatch({ title: 'The Wind through the Keyhole', position: 4.5 }, candidates);
    expect(match?.id).toBe(1);
  });

  // #2096 — the live Chapterhouse case at the matcher layer: BOTH signals used
  // to fail (member colon-truncated to `chapterhouse`, positions 6 vs a stale 17).
  it('matches Chapterhouse: Dune against a stale-position library Chapterhouse Dune', () => {
    const candidates = [{ id: 4, title: 'Chapterhouse Dune', seriesPosition: 17 }];
    const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, candidates);
    expect(match?.id).toBe(4);
  });

  it('returns null when neither signal matches', () => {
    const candidates = [{ id: 1, title: 'Some Title', seriesPosition: 1 }];
    const match = findInLibraryMatch({ title: 'Other Title', position: 5 }, candidates);
    expect(match).toBeNull();
  });

  it('handles library NULL position via title match (Hunger Games prequel pattern)', () => {
    const candidates = [{ id: 1, title: 'The Ballad of Songbirds and Snakes', seriesPosition: null }];
    const match = findInLibraryMatch({ title: 'The Ballad of Songbirds and Snakes', position: 0 }, candidates);
    expect(match?.id).toBe(1);
  });

  it('matches within floating-point tolerance for non-integer positions', () => {
    const candidates = [{ id: 1, title: 'Book', seriesPosition: 11.9 }];
    const match = findInLibraryMatch({ title: 'Different', position: 11.9 + 1e-12 }, candidates);
    expect(match?.id).toBe(1);
  });

  // #1543: when both positions are null, only the title path can match — and
  // `&` vs `and` drift must not block it, in either direction.
  it('matches `&`-title book from an `and`-title member when both positions are null', () => {
    const candidates = [{ id: 1, title: 'Night of Cake & Puppets', seriesPosition: null }];
    const match = findInLibraryMatch({ title: 'Night of Cake and Puppets', position: null }, candidates);
    expect(match?.id).toBe(1);
  });

  it('matches `and`-title book from an `&`-title member when both positions are null', () => {
    const candidates = [{ id: 1, title: 'Night of Cake and Puppets', seriesPosition: null }];
    const match = findInLibraryMatch({ title: 'Night of Cake & Puppets', position: null }, candidates);
    expect(match?.id).toBe(1);
  });

  // #1547: when both positions are null, only the title path can match — and
  // accented vs ASCII spelling drift must not block it, in either direction.
  it('matches an ASCII-title book from an accented member when both positions are null', () => {
    const candidates = [{ id: 1, title: 'Les Miserables', seriesPosition: null }];
    const match = findInLibraryMatch({ title: 'Les Misérables', position: null }, candidates);
    expect(match?.id).toBe(1);
  });

  it('matches an accented-title book from an ASCII member when both positions are null', () => {
    const candidates = [{ id: 1, title: 'Les Misérables', seriesPosition: null }];
    const match = findInLibraryMatch({ title: 'Les Miserables', position: null }, candidates);
    expect(match?.id).toBe(1);
  });

  // AC9 / G5 — position is evaluated FIRST and independently, and the
  // empty-variant guard sits BETWEEN the passes, never above them.
  describe('pass precedence', () => {
    it('position still wins over a title pairing with a different candidate', () => {
      const candidates = [
        { id: 10, title: 'The Churn', seriesPosition: 1 },
        { id: 20, title: 'Unrelated Book', seriesPosition: 6 },
      ];
      const match = findInLibraryMatch({ title: 'The Churn: An Expanse Novella', position: 6 }, candidates);
      expect(match?.id).toBe(20);
    });

    // The decisive G5 pair. An implementation that early-returns null before the
    // position pass fails the first; one that lets an empty variant set pair on
    // the title path fails the second.
    it('an empty-variant member still claims a candidate that shares its position', () => {
      const candidates = [{ id: 1, title: 'Anything', seriesPosition: 2 }];
      expect(findInLibraryMatch({ title: '[ ]', position: 2 }, candidates)?.id).toBe(1);
    });

    it('an empty-variant member with no position claims nothing', () => {
      const candidates = [{ id: 1, title: 'Anything', seriesPosition: 2 }];
      expect(findInLibraryMatch({ title: '[ ]', position: null }, candidates)).toBeNull();
    });

    it('two empty-variant titles never pair with each other', () => {
      expect(pairsOneWay('[ ]', '   ')).toBe(false);
    });

    // #2110 AC24 — the case the loosened guard newly REACHES. Before, a
    // zero-variant member early-returned before any candidate was compared;
    // now it walks the candidate list, and row 3 (exactly one FULL form empty)
    // is what refuses it.
    it('a member with identity evidence but no variants still claims nothing arbitrary', () => {
      expect(pairsBothWays('Перед бурей', 'Anything')).toBe(false);
    });
  });

  // #1139 Bug 2: callers iterating a member list pass a Set to enforce
  // first-match-wins semantics across the list.
  describe('alreadyMatched dedup', () => {
    it('skips candidates already in the alreadyMatched Set during position matching', () => {
      const candidates = [{ id: 7, title: 'Book A', seriesPosition: 2 }];
      // First call claims id=7
      const first = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates, new Set());
      expect(first?.id).toBe(7);
      // Second call with id=7 in the Set must return null even though position 2 still matches
      const second = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates, new Set([7]));
      expect(second).toBeNull();
    });

    it('skips candidates already in the alreadyMatched Set during title matching', () => {
      const candidates = [{ id: 9, title: 'The Wind Through the Keyhole', seriesPosition: 8 }];
      // Title matches but id=9 already claimed → must not match again
      const match = findInLibraryMatch(
        { title: 'The Wind through the Keyhole', position: 4.5 },
        candidates,
        new Set([9]),
      );
      expect(match).toBeNull();
    });

    it('still matches an unclaimed candidate when others in the list are already claimed', () => {
      const candidates = [
        { id: 1, title: 'Book One', seriesPosition: 1 },
        { id: 2, title: 'Book Two', seriesPosition: 2 },
      ];
      // id=1 claimed → id=2 should be matched by position 2
      const match = findInLibraryMatch({ title: 'Some Title', position: 2 }, candidates, new Set([1]));
      expect(match?.id).toBe(2);
    });

    it('first-match-wins for two members at the same position with one library book', () => {
      const candidates = [{ id: 42, title: 'Bloody Rose', seriesPosition: 2 }];
      const claimed = new Set<number>();
      // First Hardcover member at position 2 — claims id=42
      const first = findInLibraryMatch({ title: 'Hardcover Member A', position: 2 }, candidates, claimed);
      expect(first?.id).toBe(42);
      claimed.add(first!.id);
      // Second Hardcover member at position 2 — must return null
      const second = findInLibraryMatch({ title: 'Hardcover Member B', position: 2 }, candidates, claimed);
      expect(second).toBeNull();
    });

    // AC7's pinned pairing: both sides reduce to `foo` as FULL forms because the
    // edition tail is stripped by the SCALAR normalizer.
    it('first-match-wins for two members with normalized-equal titles', () => {
      const candidates = [{ id: 42, title: 'Foo (Unabridged)', seriesPosition: 99 }];
      const claimed = new Set<number>();
      const first = findInLibraryMatch({ title: 'Foo (Audio)', position: null }, candidates, claimed);
      expect(first?.id).toBe(42);
      claimed.add(first!.id);
      const second = findInLibraryMatch({ title: 'Foo (Audible)', position: null }, candidates, claimed);
      expect(second).toBeNull();
    });

    it('omitting alreadyMatched preserves the pre-#1139 single-call behavior', () => {
      const candidates = [{ id: 1, title: 'Some Title', seriesPosition: 2 }];
      const match = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates);
      expect(match?.id).toBe(1);
    });
  });

  /**
   * #2108 — the title pass ranks the acceptance arms into two tiers (EXACT:
   * `full-equals-full` / `lossless-equals-lossless`; DERIVED:
   * `derived-equals-full`) and prefers EXACT across the WHOLE pool before any
   * DERIVED candidate can claim.
   *
   * Every case here needs a MULTI-CANDIDATE pool: `pairsOneWay` /
   * `pairsBothWays` build single-candidate pools and structurally cannot observe
   * ranking at all (with one candidate there is nothing to rank, which is why
   * the entire #2096 fixture corpus is unaffected by this change — AC4).
   */
  describe('claim ranking (#2108)', () => {
    /** The reported pool: id 1 pairs `derived-equals-full`, id 9 `full-equals-full`. */
    const chapterhouse = () => [
      { id: 1, title: 'Dune', seriesPosition: null },
      { id: 9, title: 'Chapterhouse Dune', seriesPosition: 17 },
    ];

    // Counterfactual, recorded: on pre-#2108 `develop` the FIRST assertion reads
    // id 1 (single unranked scan, first-claim-wins) and the second reads id 9 —
    // exactly the order-dependence being closed.
    it('claims the exact candidate over a derived one, in the declared pool order', () => {
      const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, chapterhouse());
      expect(match?.id).toBe(9);
    });

    it('claims the exact candidate over a derived one, in the reversed pool order', () => {
      const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, [...chapterhouse()].reverse());
      expect(match?.id).toBe(9);
    });

    // The property behind the two cases above, and the assertion that fails again
    // if a single-scan shortcut is ever reintroduced. It holds for CROSS-TIER
    // pools only: within one tier AC3 keeps first-claim-wins, which makes pool
    // order decisive by design (pinned by the forced-index integration test).
    it('is order-independent for a pool spanning both tiers', () => {
      const member = { title: 'Chapterhouse: Dune', position: 6 };
      const pool = chapterhouse();
      expect(findInLibraryMatch(member, pool)?.id).toBe(findInLibraryMatch(member, [...pool].reverse())?.id);
    });

    it('claims the exact candidate even when several derived candidates precede it', () => {
      // `Dune` and `Chapterhouse` are both suffix(1)/prefix(1) offers of the
      // member; `Chapterhouse Dune` is the FULL≡FULL match, placed LAST.
      const candidates = [
        { id: 1, title: 'Dune', seriesPosition: null },
        { id: 2, title: 'Chapterhouse', seriesPosition: null },
        { id: 3, title: 'Chapterhouse Dune', seriesPosition: null },
      ];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates)?.id).toBe(3);
    });

    // AC4 — tiering is "prefer exact", never "require exact". The matchable SET
    // is exactly what it was; only the CHOICE among several changes.
    it('still claims a derived candidate when the pool holds no exact one', () => {
      const candidates = [{ id: 1, title: 'Dune', seriesPosition: null }];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates)?.id).toBe(1);
    });

    // AC3, the DERIVED half — the mirror image of the cross-tier property above.
    // With no exact candidate anywhere, first-claim-wins is the ONLY rule left,
    // so pool order is decisive BY DESIGN and reversing the pool must reverse
    // the claim. Two accepted DERIVED candidates are what makes that observable:
    // every other no-exact case here has a single derived candidate, so
    // `derived ??= candidate` and a plain `derived = candidate` (retain the LAST
    // rather than the FIRST) are indistinguishable on them. Counterfactual run
    // and recorded: that mutation flips both assertions and fails only here.
    it('claims the FIRST derived candidate when several compete and no exact one exists', () => {
      // Both pair `derived-equals-full` with the member: `dune` is its suffix(1)
      // offer, `chapterhouse` its prefix(1) offer.
      const candidates = [
        { id: 1, title: 'Dune', seriesPosition: null },
        { id: 2, title: 'Chapterhouse', seriesPosition: null },
      ];
      expect(candidates.map((c) => pairingArm('Chapterhouse: Dune', c.title))).toEqual([
        'derived-equals-full',
        'derived-equals-full',
      ]);
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates)?.id).toBe(1);
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, [...candidates].reverse())?.id).toBe(2);
    });

    // AC6 — the position pass runs first and independently of BOTH tiers.
    it('position still outranks the exact tier and the derived tier alike', () => {
      const candidates = [
        { id: 10, title: 'Dune', seriesPosition: null },
        { id: 20, title: 'Chapterhouse Dune', seriesPosition: null },
        { id: 30, title: 'Unrelated Book', seriesPosition: 6 },
      ];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, candidates)?.id).toBe(30);
    });

    // AC6 — the no-identity-evidence guard sits ABOVE both title scans, never
    // between them. Multi-candidate pools this time, so an implementation that
    // moved the guard down into the derived scan is caught.
    it('keeps the empty-variant guard above both title scans', () => {
      const candidates = [
        { id: 1, title: 'Anything', seriesPosition: 2 },
        { id: 2, title: 'Chapterhouse Dune', seriesPosition: null },
      ];
      expect(findInLibraryMatch({ title: '[ ]', position: 2 }, candidates)?.id).toBe(1);
      expect(findInLibraryMatch({ title: '[ ]', position: null }, candidates)).toBeNull();
    });

    // AC5 — `alreadyMatched` is honoured in BOTH tiers. This combination is what
    // an "exact scan, else bail" implementation gets wrong.
    it('falls through to a derived candidate when the only exact one is already claimed', () => {
      const candidates = [
        { id: 1, title: 'Chapterhouse Dune', seriesPosition: null },
        { id: 2, title: 'Dune', seriesPosition: null },
      ];
      const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates, new Set([1]));
      expect(match?.id).toBe(2);
    });

    it('claims nothing when the exact AND the derived candidate are both claimed', () => {
      const candidates = [
        { id: 1, title: 'Chapterhouse Dune', seriesPosition: null },
        { id: 2, title: 'Dune', seriesPosition: null },
      ];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates, new Set([1, 2]))).toBeNull();
    });

    // AC8 — the two EXACT arms provably never compete. `lossless-equals-lossless`
    // requires the member's FULL form to be EMPTY; `full-equals-full` and
    // `derived-equals-full` both require it to be non-empty, so a member can
    // never have candidates on both. Arms come from the independent `pairingArm`
    // model, not from the production rule under test.
    it('never puts lossless-equals-lossless in competition with another arm', () => {
      const member = 'Перед бурей';
      const candidates = [
        { id: 1, title: 'Anything', seriesPosition: null },
        { id: 2, title: 'Последний страж', seriesPosition: null },
        { id: 3, title: '  перед  БУРЕЙ (Unabridged)', seriesPosition: null },
      ];
      expect(candidates.map((c) => pairingArm(member, c.title))).toEqual([
        'none',
        'none',
        'lossless-equals-lossless',
      ]);
      expect(findInLibraryMatch({ title: member, position: null }, candidates)?.id).toBe(3);
      expect(findInLibraryMatch({ title: member, position: null }, [...candidates].reverse())?.id).toBe(3);
    });
  });
});

/**
 * The memo exists because `findInLibraryMatch` runs once per member and derives
 * every candidate's variants on each call — O(members × candidates) derivations,
 * with the persist path holding a transaction open throughout. Variant
 * generation costs strictly more than the scalar normalize it replaced, so both
 * branches carry real weight and both are invisible to every pairing assertion:
 * a hit and a miss return equal values. Derivation COUNT is the only observable
 * that can see them, which is what the `titleVariants` spy provides.
 *
 * Titles here are uniquely prefixed so these cases never collide with the raw
 * titles the pairing suites above have already warmed into the module-level map.
 */
describe('memoization', () => {
  const spy = vi.mocked(titleVariants);

  /** Run one title through the matcher, exercising exactly one member derivation. */
  function derive(title: string): void {
    findInLibraryMatch({ title, position: null }, []);
  }

  it('derives each distinct raw title exactly once across repeated calls', () => {
    const member = { title: 'F2 member — the churn: an expanse novella', position: null };
    const candidates = [{ id: 1, title: 'F2 candidate — the churn', seriesPosition: null }];

    spy.mockClear();
    findInLibraryMatch(member, candidates);
    findInLibraryMatch(member, candidates);
    findInLibraryMatch(member, candidates);

    // Three matcher calls over two raw titles → exactly two derivations, one per
    // distinct title. Delete the hit branch and this reads six.
    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      'F2 member — the churn: an expanse novella',
      'F2 candidate — the churn',
    ]);
  });

  it('reuses the memo across DIFFERENT members that share a candidate title', () => {
    const candidates = [{ id: 1, title: 'F2 shared candidate title', seriesPosition: null }];

    spy.mockClear();
    findInLibraryMatch({ title: 'F2 first member', position: null }, candidates);
    findInLibraryMatch({ title: 'F2 second member', position: null }, candidates);

    // The candidate is derived once even though two separate members scanned it —
    // this is the O(members × candidates) collapse the memo is for.
    expect(spy.mock.calls.filter((call) => call[0] === 'F2 shared candidate title')).toHaveLength(1);
  });

  // #2108 AC7 — the tiered title pass still routes EVERY candidate shape through
  // `cachedTitleShape`, and still derives the member before any candidate.
  //
  // The NO-MATCH pool is load-bearing, not incidental: a scan stops at the
  // candidate it claims, and the two conforming implementation shapes (return at
  // the first EXACT hit vs. scan the whole pool retaining the first EXACT) walk
  // different numbers of candidates on a MATCHING pool. On a no-match pool both
  // walk the whole list, which is what makes this observation stable under
  // either. It pins routing and member-first order — NOT a global derivation
  // count; AC7 disclaims those (see the `VARIANT_CACHE_MAX` case below).
  it('routes every candidate shape through the memo, member first, across both tiers', () => {
    const member = { title: 'F4 member — chapterhouse: dune', position: null };
    const candidates = [
      { id: 1, title: 'F4 candidate one', seriesPosition: null },
      { id: 2, title: 'F4 candidate two', seriesPosition: null },
      { id: 3, title: 'F4 candidate three', seriesPosition: null },
    ];

    spy.mockClear();
    expect(findInLibraryMatch(member, candidates)).toBeNull();
    findInLibraryMatch(member, candidates);

    // Four distinct raw titles → four derivations in member-first order, and the
    // second matcher call adds none. Four entries is far below VARIANT_CACHE_MAX,
    // so eviction is not in play.
    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      'F4 member — chapterhouse: dune',
      'F4 candidate one',
      'F4 candidate two',
      'F4 candidate three',
    ]);
  });

  it('clears the memo at VARIANT_CACHE_MAX so it cannot grow without bound', () => {
    const warm = 'F3 warm title that must be evicted';

    derive(warm);
    spy.mockClear();
    derive(warm);
    // Precondition: `warm` is genuinely cached, so the re-derivation asserted
    // below can only come from the clear — not from it never having been stored.
    expect(spy).not.toHaveBeenCalled();

    // Drive VARIANT_CACHE_MAX fresh titles. The map already holds `warm` (plus
    // whatever the suites above warmed), so its size necessarily reaches the
    // bound during this loop and the wholesale clear fires. `warm` is never
    // re-inserted afterwards, so it must be gone.
    for (let i = 0; i < VARIANT_CACHE_MAX; i++) derive(`F3 filler ${i}`);

    spy.mockClear();
    derive(warm);
    expect(spy).toHaveBeenCalledWith(warm);
  });
});
