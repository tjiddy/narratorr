import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  explainTitlePairing,
  findInLibraryMatch,
  normalizeMemberTitleForMatch,
  VARIANT_CACHE_MAX,
} from './series-title-match.js';
import {
  titleVariants,
  hasDegenerateFullForm,
  normalizeTitleLosslessly,
  MAX_VARIANT_TITLE_LENGTH,
} from '@core/utils/title-variants.js';
import { HardcoverClient } from '@core/metadata/hardcover.js';
import type { TitlePairArm } from '@shared/schemas/series-title-variants.js';

// Delegate to real titleVariants; call count is the only observable cache hit/miss signal because results are equal.
vi.mock('@core/utils/title-variants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/title-variants.js')>();
  return { ...actual, titleVariants: vi.fn(actual.titleVariants) };
});

describe('normalizeMemberTitleForMatch', () => {
  it('case-folds, drops punctuation, collapses whitespace', () => {
    expect(normalizeMemberTitleForMatch('The Wind Through the Keyhole')).toBe('the wind through the keyhole');
    expect(normalizeMemberTitleForMatch('The Wind through the Keyhole')).toBe('the wind through the keyhole');
  });

  // Colon truncation previously reduced Chapterhouse: Dune to chapterhouse (#2096).
  it('treats `:` as a separator instead of truncating the subtitle', () => {
    expect(normalizeMemberTitleForMatch('Foo: A Tale of Two Cities')).toBe('foo a tale of two cities');
    expect(normalizeMemberTitleForMatch('Chapterhouse: Dune')).toBe('chapterhouse dune');
  });

  // Generic paren/bracket stripping belongs only on the derived axis (#2096).
  it('retains generic parenthetical/bracket text', () => {
    expect(normalizeMemberTitleForMatch('Foundation (1951)')).toBe('foundation 1951');
    expect(normalizeMemberTitleForMatch('Foundation [1951]')).toBe('foundation 1951');
  });

  // Edition tails must strip in the scalar form; derived-only stripping makes both sides derived and breaks asymmetric pairing (AC7).
  it('strips Unabridged / Audio / Audible edition tails in the scalar form', () => {
    expect(normalizeMemberTitleForMatch('Foo (Unabridged)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audio)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audible)')).toBe('foo');
  });

  it('normalizes curly apostrophes to straight', () => {
    expect(normalizeMemberTitleForMatch('Hitchhiker’s Guide')).toBe("hitchhiker's guide");
  });

  // `&` was previously dropped instead of converging with `and` (#1543).
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

  // NFD folding preserves base letters before the alphanumeric strip (#1547).
  it('folds combining diacritics so accented and ASCII spellings converge', () => {
    // Concrete value catches a dropped-letter result that equality alone would miss.
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

  // NFD-only scope intentionally excludes transliteration of ß/ø/æ (#1547).
  it('does NOT fold non-decomposing letters (ß is not transliterated to ss)', () => {
    const out = normalizeMemberTitleForMatch('Straße');
    expect(out).not.toBe('strasse');
    expect(out).toBe('stra e');
  });
});

/**
 * Independent model of all eight ordered acceptance rows using core pure functions, not
 * explainShapePairing. Update it with the rule; FULL is the scalar normalized form.
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

function pairsOneWay(memberTitle: string, bookTitle: string): boolean {
  return findInLibraryMatch(
    { title: memberTitle, position: null },
    [{ id: 1, title: bookTitle, seriesPosition: null }],
  ) !== null;
}

function pairsBothWays(a: string, b: string): boolean {
  const forward = pairsOneWay(a, b);
  expect(pairsOneWay(b, a)).toBe(forward);
  return forward;
}

describe('title-variant pairing (#2096 fixture corpus)', () => {
  const corpus: Array<{ a: string; b: string; matches: boolean; arm: TitlePairArm }> = [
    // Live colon-truncation case.
    { a: 'Chapterhouse: Dune', b: 'Chapterhouse Dune', matches: true, arm: 'full-equals-full' },
    // Franchise-first: library owns the subtitle alone.
    { a: "The Farseer: Assassin's Apprentice", b: "Assassin's Apprentice", matches: true, arm: 'derived-equals-full' },
    // Title-first: library owns the prefix.
    { a: 'The Churn: An Expanse Novella', b: 'The Churn', matches: true, arm: 'derived-equals-full' },
    { a: 'Foo: Subtitle', b: 'Foo', matches: true, arm: 'derived-equals-full' },
    // Derived-to-derived is never accepted.
    { a: 'Series: A', b: 'Series: B', matches: false, arm: 'none' },
    { a: 'Foo: A Novel', b: 'Bar: A Novel', matches: false, arm: 'none' },
    { a: 'Star Wars: A', b: 'Star Wars: B', matches: false, arm: 'none' },
    // Paren-stripped side is derived; bare title is FULL.
    { a: 'Star Wars: The Rising Storm (The High Republic)', b: 'Star Wars: The Rising Storm', matches: true, arm: 'derived-equals-full' },
    // Colon inside parens must not create a sheared franchise prefix.
    { a: 'The Spiral Path (World of Warcraft: Traveler, Book 2)', b: 'The Spiral Path World of Warcraft', matches: false, arm: 'none' },
    // Deep-franchise first+last case.
    { a: 'star wars: the high republic: Light of the Jedi (New Order Series)', b: 'Star Wars: Light of the Jedi', matches: true, arm: 'derived-equals-full' },
    // Volume-marker collapse must not propagate here (AC18/#1896).
    { a: 'Saga Book 1', b: 'Saga Book 2', matches: false, arm: 'none' },

    // Row 6 — FULLs equal, a side degenerate, lossless forms differ.
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft: Последний страж', matches: false, arm: 'none' },
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft', matches: false, arm: 'none' },
    // Row 5 — FULLs equal, a side degenerate, lossless forms agree.
    { a: 'World of Warcraft: Перед бурей', b: 'World of Warcraft: Перед бурей', matches: true, arm: 'full-equals-full' },
    // Row 7 — a degenerate side may still OFFER a fragment that lost nothing.
    { a: "Sønner: Assassin's Apprentice", b: "Assassin's Apprentice", matches: true, arm: 'derived-equals-full' },
    // Row 8 — the offered fragment is itself lossy, so it is not evidence.
    { a: 'Star Wars: 前夜Thrawn', b: 'Thrawn', matches: false, arm: 'none' },
    // Row 7 — non-lossy sibling proves lossy is a fragment filter, not blanket refusal.
    { a: 'Star Wars: 前夜Thrawn', b: 'Star Wars', matches: true, arm: 'derived-equals-full' },
    // Row 1 — the narrow non-Latin identity arm.
    { a: 'Перед бурей', b: 'Перед бурей', matches: true, arm: 'lossless-equals-lossless' },
    // Row 2 — both FULL forms empty, lossless forms differ.
    { a: 'Перед бурей', b: 'Последний страж', matches: false, arm: 'none' },
    // Row 2 — both all-Cyrillic FULL forms are empty; no fragment-to-FULL path exists.
    { a: 'Дюна: Капитул', b: 'Капитул', matches: false, arm: 'none' },
    // Row 3 — loosened G5 reaches exactly one empty FULL and must still refuse.
    { a: 'Перед бурей', b: 'Anything', matches: false, arm: 'none' },
  ];

  // ASCII folding can erase a subtitle into a bare franchise prefix; degenerate FULL cannot anchor the derived arm (AC17).
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

    // Erased tails in any position collapse to the same FULL and must still refuse (F8).
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

    // Equal FULL forms are insufficient when either side is degenerate (F7).
    it('refuses two DISTINCT erased-tail titles that collapse to the same FULL form', () => {
      expect(normalizeMemberTitleForMatch('World of Warcraft: Перед бурей')).toBe('world of warcraft');
      expect(normalizeMemberTitleForMatch('World of Warcraft: Последний страж')).toBe('world of warcraft');
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft: Последний страж')).toBe(false);
    });

    it('refuses an erased-tail title against a genuinely bare franchise title', () => {
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft')).toBe(false);
    });

    it('still pairs the SAME non-Latin title with itself (the true positive)', () => {
      // Degenerate titles require non-lossy identity evidence, not blanket abstinence.
      expect(pairsBothWays('World of Warcraft: Перед бурей', 'World of Warcraft: Перед бурей')).toBe(true);
      expect(pairsBothWays('World of Warcraft: Перед бурей', '  world of WARCRAFT:  Перед  бурей (Unabridged)')).toBe(true);
    });

    it('still pairs two books that agree on their WHOLE normalized text', () => {
      expect(pairsBothWays('World of Warcraft', 'World of Warcraft')).toBe(true);
    });

    // Mixed erased characters can leave identical FULL text; lossless comparison distinguishes the books (F10).
    it('refuses two DISTINCT mixed-token titles that collapse to the same FULL form', () => {
      expect(normalizeMemberTitleForMatch('World of Warcraft: A前夜')).toBe('world of warcraft a');
      expect(normalizeMemberTitleForMatch('World of Warcraft: A後夜')).toBe('world of warcraft a');
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft: A後夜')).toBe(false);
    });

    it('refuses a mixed-token title against the bare title its FULL form collides with', () => {
      expect(normalizeMemberTitleForMatch('World of Warcraft A')).toBe('world of warcraft a');
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft A')).toBe(false);
    });

    it('still pairs the SAME mixed-token title with itself', () => {
      expect(pairsBothWays('World of Warcraft: A前夜', 'World of Warcraft: A前夜')).toBe(true);
    });

    // Degeneracy disqualifies a trusted FULL side, not a non-lossy fragment offerer; otherwise AC11 breaks.
    it('lets a degenerate title still OFFER a fragment to a non-degenerate FULL side', () => {
      expect(hasDegenerateFullForm("Sønner: Assassin's Apprentice")).toBe(true);
      expect(pairsBothWays("Sønner: Assassin's Apprentice", "Assassin's Apprentice")).toBe(true);
      expect(pairsBothWays('Foo: Subtitle', 'Foo')).toBe(true);
      expect(pairsBothWays('World of Warcraft: Beyond the Dark Portal', 'World of Warcraft')).toBe(true);
      // Same degenerate title offers a non-lossy fragment even though its lossy fragment is refused (#2110).
      expect(pairsBothWays('Star Wars: 前夜Thrawn', 'Star Wars')).toBe(true);
    });

    /** Offering fragments must also survive folding; otherwise franchise cross-matches re-enter one level down (#2110). */
    describe('lossy derived fragments are not evidence (#2110)', () => {
      it('refuses a Russian-edition-with-translation title claiming the bare franchise', () => {
        // First-wins dedup shadows the non-lossy prefix with a lossy paren-stripped FULL.
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
      // Deep-franchise first+last keeps a distinguishing non-degenerate FULL side.
      expect(pairsBothWays(
        'star wars: the high republic: Light of the Jedi (New Order Series)',
        'Star Wars: Light of the Jedi',
      )).toBe(true);
    });

    it('still rescues an erased-subtitle member by POSITION', () => {
      const candidates = [{ id: 1, title: 'World of Warcraft: Beyond the Dark Portal', seriesPosition: 15 }];
      expect(findInLibraryMatch({ title: 'World of Warcraft: Перед бурей', position: 15 }, candidates)?.id).toBe(1);
    });
  });

  /** Compare real matching, independent model, and production arm label; boolean checks cannot catch a mislabeled arm (#2110 AC38). */
  it.each(corpus)('$a ↔ $b → $matches via $arm', ({ a, b, matches, arm }) => {
    expect(pairsBothWays(a, b)).toBe(matches);
    expect(pairingArm(a, b)).toBe(arm);
    expect(explainTitlePairing(a, b).arm).toBe(arm);
  });

  describe('rule properties (#2110)', () => {
    const probes = [...new Set([
      ...corpus.flatMap(({ a, b }) => [a, b]),
      'World of Warcraft: A前夜',
      'Sa᷀ga: Book One',
      'Straße: Beyond the Dark Portal',
      // Raw-character reflexivity checks misclassify every boundary below (AC19).
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
     * Reflexivity domain is exactly non-empty normalizeTitleLosslessly output. Raw character
     * classes fail both ways: `&` becomes `and`, while `(Audio)` becomes empty.
     */
    it('is reflexive exactly where the lossless form is non-empty', () => {
      const inDomain = probes.filter((t) => normalizeTitleLosslessly(t) !== '');
      expect(inDomain.length).toBeGreaterThan(0);
      for (const t of inDomain) expect(explainTitlePairing(t, t).pairs).toBe(true);
    });

    /** Outside the domain, self-pair refusal prevents distinct untitled members claiming each other (AC24 row 2). */
    it('refuses a self-pair outside the domain', () => {
      const outOfDomain = probes.filter((t) => normalizeTitleLosslessly(t) === '');
      expect(outOfDomain.length).toBeGreaterThan(0);
      for (const t of outOfDomain) {
        expect(explainTitlePairing(t, t)).toMatchObject({ pairs: false, arm: 'none' });
      }
    });

    /** Pin every AC19 boundary; `[ ]` alone cannot distinguish normalized-domain logic from a raw character class. */
    it.each([
      ['&', 'and', 'full-equals-full'],
      ['+', 'and', 'full-equals-full'],
      // Curly apostrophe folds before the keep class.
      ['’', "'", 'full-equals-full'],
      ["'", "'", 'full-equals-full'],
      // Edition-tail stripping removes all letters.
      ['(Audio)', '', 'none'],
      ['[Audible]', '', 'none'],
      ['(Unabridged)', '', 'none'],
      ['[ ]', '', 'none'],
      ['   ', '', 'none'],
      // Empty variants/FULL can still have lossless identity evidence.
      ['Перед бурей', 'перед бурей', 'lossless-equals-lossless'],
    ])('self-pairs %j (lossless %j) via arm %s', (title, lossless, arm) => {
      expect(normalizeTitleLosslessly(title)).toBe(lossless);
      expect(explainTitlePairing(title, title)).toMatchObject({ pairs: arm !== 'none', arm });
    });
  });
});

/** All-non-Latin titles have empty scalar/variants, so a narrow lossless identity arm is required to pair identical titles (#2110). */
describe('non-Latin identity arm (#2110)', () => {
  it('pairs two identical non-Latin titles', () => {
    expect(titleVariants('Перед бурей')).toEqual([]);
    expect(normalizeMemberTitleForMatch('Перед бурей')).toBe('');
    expect(pairsBothWays('Перед бурей', 'Перед бурей')).toBe(true);
  });

  it('tolerates the same drift every other arm tolerates', () => {
    expect(pairsBothWays('Перед бурей', '  перед  БУРЕЙ (Unabridged)')).toBe(true);
  });

  it('pairs across a colon the way the scalar form does for Latin titles', () => {
    expect(pairsBothWays('Перед: бурей', 'Перед бурей')).toBe(true);
  });

  it('refuses two DIFFERENT non-Latin titles', () => {
    expect(pairsBothWays('Перед бурей', 'Последний страж')).toBe(false);
  });

  /** Non-Latin identity does not widen fragments: two empty FULLs use row 2; exactly one empty FULL uses row 3 (AC25). */
  it('offers no non-Latin fragment-to-FULL path', () => {
    expect(normalizeMemberTitleForMatch('Дюна: Капитул')).toBe('');
    expect(normalizeMemberTitleForMatch('Капитул')).toBe('');
    expect(pairsBothWays('Дюна: Капитул', 'Капитул')).toBe(false);
  });

  it('refuses a non-Latin title against an unrelated Latin one', () => {
    expect(pairsBothWays('Перед бурей', 'Anything')).toBe(false);
  });

  /**
   * Rule change alone is inert if findInLibraryMatch still exits on zero variants; this assertion
   * pins the loosened pre-candidate guard as well as lossless-equals-lossless.
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
    const candidates = [{ id: 1, title: 'The Wind Through the Keyhole', seriesPosition: 8 }];
    const match = findInLibraryMatch({ title: 'The Wind through the Keyhole', position: 4.5 }, candidates);
    expect(match?.id).toBe(1);
  });

  // The live #2096 case fails both signals: colon truncation and stale positions.
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

  // Null positions isolate the title-path `&`/`and` regression (#1543).
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

  // Null positions isolate the title-path accent-folding regression (#1547).
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

  // Position runs before the empty-variant guard; title matching runs after it (AC9/G5).
  describe('pass precedence', () => {
    it('position still wins over a title pairing with a different candidate', () => {
      const candidates = [
        { id: 10, title: 'The Churn', seriesPosition: 1 },
        { id: 20, title: 'Unrelated Book', seriesPosition: 6 },
      ];
      const match = findInLibraryMatch({ title: 'The Churn: An Expanse Novella', position: 6 }, candidates);
      expect(match?.id).toBe(20);
    });

    // This pair distinguishes an early guard before position from a missing guard before title matching.
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

    // The loosened zero-variant guard now reaches row 3, which must still refuse (#2110 AC24).
    it('a member with identity evidence but no variants still claims nothing arbitrary', () => {
      expect(pairsBothWays('Перед бурей', 'Anything')).toBe(false);
    });
  });

  describe('alreadyMatched dedup', () => {
    it('skips candidates already in the alreadyMatched Set during position matching', () => {
      const candidates = [{ id: 7, title: 'Book A', seriesPosition: 2 }];
      const first = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates, new Set());
      expect(first?.id).toBe(7);
      const second = findInLibraryMatch({ title: 'Different Title', position: 2 }, candidates, new Set([7]));
      expect(second).toBeNull();
    });

    it('skips candidates already in the alreadyMatched Set during title matching', () => {
      const candidates = [{ id: 9, title: 'The Wind Through the Keyhole', seriesPosition: 8 }];
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
      const match = findInLibraryMatch({ title: 'Some Title', position: 2 }, candidates, new Set([1]));
      expect(match?.id).toBe(2);
    });

    it('first-match-wins for two members at the same position with one library book', () => {
      const candidates = [{ id: 42, title: 'Bloody Rose', seriesPosition: 2 }];
      const claimed = new Set<number>();
      const first = findInLibraryMatch({ title: 'Hardcover Member A', position: 2 }, candidates, claimed);
      expect(first?.id).toBe(42);
      claimed.add(first!.id);
      const second = findInLibraryMatch({ title: 'Hardcover Member B', position: 2 }, candidates, claimed);
      expect(second).toBeNull();
    });

    // Scalar edition-tail stripping makes all three titles FULL-equal (AC7).
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
   * Rank EXACT (full/lossless equality) over DERIVED across the whole pool.
   * Multi-candidate pools are required to observe ranking; single-candidate corpus cases cannot (#2108).
   */
  describe('claim ranking (#2108)', () => {
    const chapterhouse = () => [
      { id: 1, title: 'Dune', seriesPosition: null },
      { id: 9, title: 'Chapterhouse Dune', seriesPosition: 17 },
    ];

    // Pre-#2108 single-scan order chooses id 1 only when derived appears first.
    it('claims the exact candidate over a derived one, in the declared pool order', () => {
      const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, chapterhouse());
      expect(match?.id).toBe(9);
    });

    it('claims the exact candidate over a derived one, in the reversed pool order', () => {
      const match = findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, [...chapterhouse()].reverse());
      expect(match?.id).toBe(9);
    });

    // Cross-tier choice is order-independent; within-tier remains first-claim-wins.
    it('is order-independent for a pool spanning both tiers', () => {
      const member = { title: 'Chapterhouse: Dune', position: 6 };
      const pool = chapterhouse();
      expect(findInLibraryMatch(member, pool)?.id).toBe(findInLibraryMatch(member, [...pool].reverse())?.id);
    });

    it('claims the exact candidate even when several derived candidates precede it', () => {
      const candidates = [
        { id: 1, title: 'Dune', seriesPosition: null },
        { id: 2, title: 'Chapterhouse', seriesPosition: null },
        { id: 3, title: 'Chapterhouse Dune', seriesPosition: null },
      ];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates)?.id).toBe(3);
    });

    // Tiering prefers exact; it does not require exact (AC4).
    it('still claims a derived candidate when the pool holds no exact one', () => {
      const candidates = [{ id: 1, title: 'Dune', seriesPosition: null }];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: null }, candidates)?.id).toBe(1);
    });

    // Within DERIVED, first-claim-wins by design. Two accepted candidates distinguish retaining first (`??=`) from last (`=`); reversing the pool must reverse the winner (AC3).
    it('claims the FIRST derived candidate when several compete and no exact one exists', () => {
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

    it('position still outranks the exact tier and the derived tier alike', () => {
      const candidates = [
        { id: 10, title: 'Dune', seriesPosition: null },
        { id: 20, title: 'Chapterhouse Dune', seriesPosition: null },
        { id: 30, title: 'Unrelated Book', seriesPosition: 6 },
      ];
      expect(findInLibraryMatch({ title: 'Chapterhouse: Dune', position: 6 }, candidates)?.id).toBe(30);
    });

    it('keeps the empty-variant guard above both title scans', () => {
      const candidates = [
        { id: 1, title: 'Anything', seriesPosition: 2 },
        { id: 2, title: 'Chapterhouse Dune', seriesPosition: null },
      ];
      expect(findInLibraryMatch({ title: '[ ]', position: 2 }, candidates)?.id).toBe(1);
      expect(findInLibraryMatch({ title: '[ ]', position: null }, candidates)).toBeNull();
    });

    // AC5: `alreadyMatched` is honored in both tiers; exact-scan-else-bail gets this combination wrong.
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

    // Exact arms cannot compete: lossless equality requires empty member FULL, while full equality requires non-empty FULL (AC8).
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
 * Candidate derivation would be O(members × candidates) inside a transaction. Pairing cannot
 * distinguish cache hits because values match, so spy call count is the observation point.
 * Unique prefixes avoid cache warmth from earlier suites.
 */
describe('memoization', () => {
  const spy = vi.mocked(titleVariants);

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

    // Three matcher calls over two titles derive exactly two shapes; deleting the hit branch yields six.
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

    // Two members derive their shared candidate once, collapsing the multiplicative work.
    expect(spy.mock.calls.filter((call) => call[0] === 'F2 shared candidate title')).toHaveLength(1);
  });

  /**
   * A no-match pool forces both valid scan implementations to visit every candidate, making
   * member-first memo routing stable. Matching pools stop at implementation-dependent points (#2108 AC7).
   */
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

    // Four distinct titles derive in member-first order; the repeat adds none and cannot trigger eviction.
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
    // Prove `warm` was cached so later re-derivation can only come from the clear.
    expect(spy).not.toHaveBeenCalled();

    // Fresh titles force the wholesale clear; `warm` is never reinserted afterward.
    for (let i = 0; i < VARIANT_CACHE_MAX; i++) derive(`F3 filler ${i}`);

    spy.mockClear();
    derive(warm);
    expect(spy).toHaveBeenCalledWith(warm);
  });
});

/**
 * Over-length members must be dropped, never truncated. Truncation to X would FULL-match the
 * library book and durably rewrite its series fields; null position isolates that counterfactual (#2109 T13b).
 */
describe('an over-length Hardcover member never reaches the matcher (#2109 T13b)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('drops it at mapSeries, so it cannot claim the library book named by its prefix', async () => {
    const X = 'The Long Corrupt Title '.repeat(90).slice(0, MAX_VARIANT_TITLE_LENGTH);
    expect(X).toHaveLength(MAX_VARIANT_TITLE_LENGTH);
    const memberTitle = `${X} Distinguishing Suffix`;

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        series: [{
          id: 1,
          name: 'A',
          slug: 'a',
          author: { name: 'Y' },
          book_series: [{ position: 1, book: { id: 101, slug: 'b', title: memberTitle, image: null, users_count: 1 } }],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const series = await new HardcoverClient('K').getSeriesMembers('A', 'Y');
    expect(series!.members).toEqual([]);

    // Null position isolates the title arm that truncation would have won.
    const libraryBook = { id: 7, title: X, seriesPosition: null };
    const claims = series!.members.map((m) => findInLibraryMatch({ title: m.title, position: m.position }, [libraryBook]));
    expect(claims).toEqual([]);

    // Prove a truncated X would FULL-match the library book.
    expect(findInLibraryMatch({ title: X, position: 1 }, [libraryBook])).toBe(libraryBook);
  });
});
