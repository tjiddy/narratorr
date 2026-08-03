import { describe, it, expect, vi } from 'vitest';
import { findInLibraryMatch, normalizeMemberTitleForMatch, VARIANT_CACHE_MAX } from './series-title-match.js';
import { titleVariants, hasDegenerateFullForm } from '@core/utils/title-variants.js';

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
 * Which arm of the #2096 asymmetric rule a pairing reaches, derived independently
 * from the variant sets so a test can pin the arm, not just the boolean. FULL is
 * `{ tag: 'full', parensStripped: false }`, which is the scalar normalized form
 * by construction.
 */
function pairingArm(a: string, b: string): 'full-equals-full' | 'derived-equals-full' | 'none' {
  const aFull = normalizeMemberTitleForMatch(a);
  const bFull = normalizeMemberTitleForMatch(b);
  if (aFull.length === 0 || bFull.length === 0) return 'none';
  if (aFull === bFull) return 'full-equals-full';
  const derived = (title: string): string[] =>
    titleVariants(title).filter((v) => v.tag !== 'full' || v.parensStripped).map((v) => v.raw);
  if (derived(a).includes(bFull) || derived(b).includes(aFull)) return 'derived-equals-full';
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
  const corpus: Array<{ a: string; b: string; matches: boolean; arm: ReturnType<typeof pairingArm> }> = [
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

  it.each(corpus)('$a ↔ $b → $matches via $arm', ({ a, b, matches, arm }) => {
    expect(pairsBothWays(a, b)).toBe(matches);
    expect(pairingArm(a, b)).toBe(arm);
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
