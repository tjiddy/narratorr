import { describe, it, expect } from 'vitest';
import {
  compareRecordingNarrators,
  resolveRecordingIdentity,
  deriveEditionLabel,
  type NarratorEquality,
  type RecordingCandidate,
  type LibraryRecording,
  type RecordingVerdict,
} from './recording-identity.js';

/** Prod specimen (#2206): the full-cast Golden Compass listing, placeholder credited alongside the named cast. */
const GOLDEN_COMPASS_FULL_CAST = [
  'Philip Pullman', 'Joanna Wyatt', 'Rupert Degas', 'Alison Dowling', 'Douglas Blackwell',
  'Jill Shilling', 'Stephen Thorne', 'Sean Barrett', 'Garrick Hagon', "John O'Connor",
  'Susan Sheridan', 'Full Cast',
];

describe('compareRecordingNarrators (#1710)', () => {
  it('equal sets → equal', () => {
    expect(compareRecordingNarrators(['Jim Dale'], ['Jim Dale'])).toBe('equal');
    expect(compareRecordingNarrators(['A', 'B'], ['B', 'A'])).toBe('equal');
  });

  it('superset → not-equal (file {A,B} vs edition {A})', () => {
    expect(compareRecordingNarrators(['Kate Reading', 'Michael Kramer'], ['Kate Reading'])).toBe('not-equal');
  });

  it('subset → not-equal (file {A} vs edition {A,B})', () => {
    expect(compareRecordingNarrators(['Kate Reading'], ['Kate Reading', 'Michael Kramer'])).toBe('not-equal');
  });

  it('normalized variants converge (diacritics, parenthetical, initials)', () => {
    expect(compareRecordingNarrators(['Thérèse'], ['Therese'])).toBe('equal');
    expect(compareRecordingNarrators(['James Marsters (Spike)'], ['James Marsters'])).toBe('equal');
    expect(compareRecordingNarrators(['R. C. Bray'], ['R.C. Bray'])).toBe('equal');
  });

  it('all-placeholder array → no-signal', () => {
    expect(compareRecordingNarrators(['full cast'], ['Jim Dale'])).toBe('no-signal');
    expect(compareRecordingNarrators(['various'], ['Jim Dale'])).toBe('no-signal');
    expect(compareRecordingNarrators(['full cast'], ['various'])).toBe('no-signal');
  });

  it('asymmetric real-vs-placeholder → no-signal, not a spurious not-equal', () => {
    expect(compareRecordingNarrators(['Jim Dale'], ['full cast'])).toBe('no-signal');
  });

  it('punctuation-only narrators normalize empty → no-signal', () => {
    expect(compareRecordingNarrators(['-'], ['Jim Dale'])).toBe('no-signal');
    expect(compareRecordingNarrators(['.'], ['Jim Dale'])).toBe('no-signal');
  });

  it('initials-collapse collision pin: R. C. Bray is not equal to R. K. Bray (#1657)', () => {
    expect(compareRecordingNarrators(['R. C. Bray'], ['R. K. Bray'])).toBe('not-equal');
  });

  describe('packed narrator strings tokenize before comparison (#1725)', () => {
    it('comma-packed candidate vs split library → equal', () => {
      expect(compareRecordingNarrators(['Kate Reading, Michael Kramer'], ['Kate Reading', 'Michael Kramer'])).toBe('equal');
    });

    it('semicolon- and ampersand-packed variants → equal', () => {
      expect(compareRecordingNarrators(['Kate Reading; Michael Kramer'], ['Kate Reading', 'Michael Kramer'])).toBe('equal');
      expect(compareRecordingNarrators(['Kate Reading & Michael Kramer'], ['Kate Reading', 'Michael Kramer'])).toBe('equal');
    });

    it('packed on both sides and packed-on-library-side-only → equal parity', () => {
      expect(compareRecordingNarrators(['Kate Reading, Michael Kramer'], ['Kate Reading, Michael Kramer'])).toBe('equal');
      expect(compareRecordingNarrators(['Kate Reading', 'Michael Kramer'], ['Kate Reading, Michael Kramer'])).toBe('equal');
    });

    it('packed superset stays not-equal (file {A,B} vs edition {A})', () => {
      expect(compareRecordingNarrators(['Kate Reading, Michael Kramer'], ['Kate Reading'])).toBe('not-equal');
    });
  });

  describe('one-sided placeholder → no-signal, never collapses to the survivor (#1725)', () => {
    it('lead-plus-fullcast vs lead → no-signal (not equal)', () => {
      expect(compareRecordingNarrators(['Full Cast', 'Jim Dale'], ['Jim Dale'])).toBe('no-signal');
    });

    it('packed placeholder-only candidate → no-signal (no leaked token)', () => {
      expect(compareRecordingNarrators(['Full Cast, Various'], ['Jim Dale'])).toBe('no-signal');
    });

    it('regression: all-placeholder both sides stays no-signal', () => {
      expect(compareRecordingNarrators(['Full Cast'], ['Various'])).toBe('no-signal');
      expect(compareRecordingNarrators(['Full Cast, Various'], ['Various Narrators'])).toBe('no-signal');
    });

    it('regression: symmetric placeholders on both sides compare survivors (unchanged)', () => {
      expect(compareRecordingNarrators(['Full Cast', 'Jim Dale'], ['Full Cast', 'Jim Dale'])).toBe('equal');
    });
  });

  // Every row is asserted in BOTH argument orders, so an implementation whose verdict depends on
  // which side is `a` fails the row it belongs to rather than escaping through a hand-picked subset.
  describe('placeholder asymmetry only suppresses equality, never a decided mismatch (#2206)', () => {
    interface ComparatorRow {
      name: string;
      a: string[];
      b: string[];
      expected: NarratorEquality;
    }

    const rows: ComparatorRow[] = [
      { name: 'specimen: full cast + 11 named vs solo incumbent', a: GOLDEN_COMPASS_FULL_CAST, b: ['Ruth Wilson'], expected: 'not-equal' },
      { name: 'disjoint survivors, one-sided placeholder', a: ['Full Cast', 'Jim Dale'], b: ['Stephen Fry'], expected: 'not-equal' },
      // Deliberate: AC1 is "survivors differ", not "survivors are disjoint". The placeholder side could
      // in principle be crediting Kate Reading among its uncredited voices, so this trades a possible
      // spurious second edition (the operator deletes one row) for the refusal being fixed. It does NOT
      // reopen #1725, whose hazard is a silent OVERWRITE and lives only on the `equal` branch.
      { name: 'overlapping-but-unequal survivors, one-sided placeholder', a: ['Full Cast', 'Jim Dale'], b: ['Jim Dale', 'Kate Reading'], expected: 'not-equal' },
      { name: 'placeholder vocabulary is not Full Cast-specific', a: ['Various', 'Jim Dale'], b: ['Stephen Fry'], expected: 'not-equal' },
      { name: '#1725: equal survivors, one-sided placeholder stays undecidable', a: ['Full Cast', 'Jim Dale'], b: ['Jim Dale'], expected: 'no-signal' },
      { name: 'all-placeholder side vs named side', a: ['Full Cast'], b: ['Jim Dale'], expected: 'no-signal' },
      { name: 'all-placeholder on both sides, packed', a: ['Full Cast, Various'], b: ['Various Narrators'], expected: 'no-signal' },
      { name: 'empty array', a: [], b: ['Jim Dale'], expected: 'no-signal' },
      { name: 'punctuation-only entry normalizes empty', a: ['-'], b: ['Jim Dale'], expected: 'no-signal' },
      { name: 'no placeholder on either side, disjoint', a: ['Stephen Fry'], b: ['Jim Dale'], expected: 'not-equal' },
      { name: 'no placeholder on either side, superset', a: ['Kate Reading', 'Michael Kramer'], b: ['Kate Reading'], expected: 'not-equal' },
      { name: 'identical named sets', a: ['Jim Dale'], b: ['Jim Dale'], expected: 'equal' },
      { name: 'symmetric placeholders over equal survivors', a: ['Full Cast', 'Jim Dale'], b: ['Full Cast', 'Jim Dale'], expected: 'equal' },
      { name: 'packed-delimiter parity', a: ['Kate Reading, Michael Kramer'], b: ['Kate Reading', 'Michael Kramer'], expected: 'equal' },
    ];

    it.each(rows)('$name → $expected', ({ a, b, expected }) => {
      expect(compareRecordingNarrators(a, b)).toBe(expected);
      expect(compareRecordingNarrators(b, a)).toBe(expected);
    });
  });
});

describe('deriveEditionLabel (#1711)', () => {
  it('returns the primary signal-carrying narrator display name', () => {
    expect(deriveEditionLabel(['Stephen Fry'])).toBe('Stephen Fry');
    expect(deriveEditionLabel(['Jim Dale', 'Someone Else'])).toBe('Jim Dale');
  });

  it('skips placeholders and picks the first real narrator', () => {
    expect(deriveEditionLabel(['Full Cast', 'Jason Isaacs'])).toBe('Jason Isaacs');
  });

  it('falls back to the production form when no usable narrator signal exists', () => {
    expect(deriveEditionLabel(['full cast'], 'full_cast')).toBe('Full Cast');
    expect(deriveEditionLabel([], 'dramatized')).toBe('Dramatized');
  });

  it('returns null when nothing stable distinguishes the recording', () => {
    expect(deriveEditionLabel([])).toBeNull();
    expect(deriveEditionLabel(['full cast'])).toBeNull();
    expect(deriveEditionLabel([], 'unknown')).toBeNull();
  });

  it('trims surrounding whitespace from the narrator name', () => {
    expect(deriveEditionLabel(['  Kate Reading  '])).toBe('Kate Reading');
  });

  // Normalization decides whether signal exists; the stable human-facing label remains raw and trimmed.
  it('returns the raw label for a parenthetical name (divergent from the normalized form)', () => {
    expect(deriveEditionLabel(['James Marsters (Spike)'])).toBe('James Marsters (Spike)');
  });

  it('returns the raw label for a role-prefixed name (divergent from the normalized form)', () => {
    expect(deriveEditionLabel(['Narrator: Jim Dale'])).toBe('Narrator: Jim Dale');
  });

  // Native-tag strings must tokenize before placeholder filtering or the packed label leaks into the folder.
  it('tokenizes a packed real+placeholder entry and picks the first signal token (all delimiters)', () => {
    expect(deriveEditionLabel(['Full Cast, Jim Dale'])).toBe('Jim Dale');
    expect(deriveEditionLabel(['Full Cast; Jim Dale'])).toBe('Jim Dale');
    expect(deriveEditionLabel(['Full Cast & Jim Dale'])).toBe('Jim Dale');
  });

  it('tokenizes a packed placeholder-after-real entry and picks the first signal token', () => {
    expect(deriveEditionLabel(['Jim Dale, Full Cast'])).toBe('Jim Dale');
    expect(deriveEditionLabel(['Jim Dale & Full Cast'])).toBe('Jim Dale');
  });

  it('picks the first signal token (raw, trimmed) from a packed two-real entry', () => {
    expect(deriveEditionLabel(['Kate Reading, Michael Kramer'])).toBe('Kate Reading');
  });

  it('falls through to the production form when a packed entry is all placeholders', () => {
    expect(deriveEditionLabel(['Full Cast, Various'], 'full_cast')).toBe('Full Cast');
  });

  it('returns null for a packed all-placeholder entry with no/unknown production type', () => {
    expect(deriveEditionLabel(['Full Cast, Various'])).toBeNull();
    expect(deriveEditionLabel(['Full Cast, Various'], 'unknown')).toBeNull();
  });
});

function candidate(overrides: Partial<RecordingCandidate> = {}): RecordingCandidate {
  return { title: 'T', authors: ['Author One'], narrators: [], ...overrides };
}

function library(overrides: Partial<LibraryRecording> = {}): LibraryRecording {
  return { title: 'T', primaryAuthorSlug: 'author-one', narrators: [], ...overrides };
}

/** Verdict-only convenience; reason-flow cases use the full result. */
function verdictOf(c: RecordingCandidate, e: LibraryRecording): RecordingVerdict {
  return resolveRecordingIdentity(c, e).verdict;
}

describe('resolveRecordingIdentity (#1710)', () => {
  it('ASIN-equal short-circuits to same-recording (case-insensitive)', () => {
    const verdict = verdictOf(
      candidate({ asin: 'b01abc', narrators: ['X'] }),
      library({ asin: 'B01ABC', narrators: ['Y'] }),
    );
    expect(verdict).toBe('same-recording');
  });

  it('different ASIN does NOT short-circuit — defers to narrator (Tehanu)', () => {
    const verdict = verdictOf(
      candidate({ asin: 'B-NEW', title: 'Tehanu', authors: ['Ursula K. Le Guin'], narrators: ['Jenny Sterlin'], duration: 420 }),
      library({ asin: 'B-OLD', title: 'Tehanu', primaryAuthorSlug: 'ursula-k-le-guin', narrators: ['Jenny Sterlin'], duration: 420 }),
    );
    expect(verdict).toBe('same-recording');
  });

  describe('single-sided ASIN falls through to the narrator path (#1729)', () => {
    it('candidate-only ASIN + matching title/author + equal narrators → same-recording (via narrator)', () => {
      expect(verdictOf(
        candidate({ asin: 'B01ABC', narrators: ['Jim Dale'] }),
        library({ asin: null, narrators: ['Jim Dale'] }),
      )).toBe('same-recording');
    });

    it('candidate-only ASIN + matching title/author + not-equal narrators → different-recording (ASIN did not short-circuit)', () => {
      expect(verdictOf(
        candidate({ asin: 'B01ABC', narrators: ['Jim Dale'] }),
        library({ asin: null, narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('different-recording');
    });

    it('entry-only ASIN + matching title/author + equal narrators → same-recording (via narrator)', () => {
      expect(verdictOf(
        candidate({ asin: null, narrators: ['Jim Dale'] }),
        library({ asin: 'B01ABC', narrators: ['Jim Dale'] }),
      )).toBe('same-recording');
    });

    it('entry-only ASIN + matching title/author + not-equal narrators → different-recording (ASIN did not short-circuit)', () => {
      expect(verdictOf(
        candidate({ asin: null, narrators: ['Jim Dale'] }),
        library({ asin: 'B01ABC', narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('different-recording');
    });
  });

  // Unequal narrators ensure only canonical ASIN equality can produce same-recording.
  it('whitespace-padded candidate ASIN canonicalizes and short-circuits → same-recording (#1729 gap b)', () => {
    expect(verdictOf(
      candidate({ asin: ' B01ABC ', narrators: ['X'] }),
      library({ asin: 'B01ABC', narrators: ['Y'] }),
    )).toBe('same-recording');
  });

  it('crux: HP single narrator vs full-cast superset → different-recording', () => {
    const verdict = verdictOf(
      candidate({ title: "Harry Potter and the Sorcerer's Stone", authors: ['J. K. Rowling'], narrators: ['Jim Dale', 'Extra Cast Member'] }),
      library({ title: "Harry Potter and the Sorcerer's Stone", primaryAuthorSlug: 'j-k-rowling', narrators: ['Jim Dale'] }),
    );
    expect(verdict).toBe('different-recording');
  });

  it('no-signal narrator (placeholder / unknown) → review', () => {
    const verdict = verdictOf(
      candidate({ narrators: ['Multiple Readers'] }),
      library({ narrators: ['Jim Dale'] }),
    );
    expect(verdict).toBe('review');
  });

  it('not-equal/superset under matching title+author → different-recording', () => {
    const verdict = verdictOf(
      candidate({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      library({ narrators: ['Kate Reading'] }),
    );
    expect(verdict).toBe('different-recording');
  });

  it('no title+author match → different-recording (new book)', () => {
    expect(verdictOf(
      candidate({ title: 'Wholly Different', narrators: ['X'] }),
      library({ title: 'Original', narrators: ['X'] }),
    )).toBe('different-recording');
    expect(verdictOf(
      candidate({ authors: ['Someone Else'], narrators: ['X'] }),
      library({ primaryAuthorSlug: 'author-one', narrators: ['X'] }),
    )).toBe('different-recording');
  });

  describe('author-less scope aligns with matchesLibraryIdentity (#1726)', () => {
    it('both author-less with byte-identical titles ENTER scope → driven by narrator (equal → same-recording)', () => {
      expect(verdictOf(
        candidate({ title: 'Tehanu', authors: [], narrators: ['X'] }),
        library({ title: 'Tehanu', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('same-recording');
    });

    it('both author-less, exact title, not-equal narrators → different-recording (gate passed, narrator separates)', () => {
      expect(verdictOf(
        candidate({ title: 'Tehanu', authors: [], narrators: ['Kate Reading', 'Michael Kramer'] }),
        library({ title: 'Tehanu', primaryAuthorSlug: '', narrators: ['Kate Reading'] }),
      )).toBe('different-recording');
    });

    it('both author-less, subtitle drift (raw titles differ) → different-recording (not scoped together)', () => {
      expect(verdictOf(
        candidate({ title: 'Dune (Unabridged)', authors: [], narrators: ['X'] }),
        library({ title: 'Dune', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('author-less candidate vs authored entry → different-recording (one-sided, no regression)', () => {
      expect(verdictOf(
        candidate({ title: 'The Stranger', authors: [], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: 'author-one', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('authored candidate vs author-less entry → different-recording (one-sided, no regression)', () => {
      expect(verdictOf(
        candidate({ title: 'The Stranger', authors: ['Author One'], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('different-recording');
    });
  });

  describe('title-normalization drift scopes to the same incumbent', () => {
    it('colon subtitle (Mistborn: The Final Empire vs Mistborn)', () => {
      const verdict = verdictOf(
        candidate({ title: 'Mistborn: The Final Empire', narrators: ['Michael Kramer'] }),
        library({ title: 'Mistborn', narrators: ['Michael Kramer'] }),
      );
      expect(verdict).toBe('same-recording');
    });

    it('trailing parenthetical (Dune (Unabridged) vs Dune)', () => {
      const verdict = verdictOf(
        candidate({ title: 'Dune (Unabridged)', narrators: ['Scott Brick'] }),
        library({ title: 'Dune', narrators: ['Scott Brick'] }),
      );
      expect(verdict).toBe('same-recording');
    });

    it('series-marker drift (Foo, Book 1 vs Foo)', () => {
      const verdict = verdictOf(
        candidate({ title: 'Foo, Book 1', narrators: ['Scott Brick'] }),
        library({ title: 'Foo', narrators: ['Scott Brick'] }),
      );
      expect(verdict).toBe('same-recording');
    });
  });

  describe('packed + one-sided-placeholder narrator shapes (#1725)', () => {
    it('comma-packed candidate vs split library, absent duration → same-recording', () => {
      expect(verdictOf(
        candidate({ narrators: ['Kate Reading, Michael Kramer'] }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('same-recording');
    });

    it('comma-packed candidate vs split library, close duration → same-recording', () => {
      expect(verdictOf(
        candidate({ narrators: ['Kate Reading, Michael Kramer'], duration: 600 }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'], duration: 601 }),
      )).toBe('same-recording');
    });

    it('previously-different-recording packed case now flips to same-recording (Bug-1 repair)', () => {
      expect(compareRecordingNarrators(['Kate Reading, Michael Kramer'], ['Kate Reading', 'Michael Kramer'])).toBe('equal');
      expect(verdictOf(
        candidate({ narrators: ['Kate Reading, Michael Kramer'] }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('same-recording');
    });

    it('lead-plus-fullcast candidate vs lead library → review, NOT same-recording (Bug-2 guard)', () => {
      expect(verdictOf(
        candidate({ narrators: ['Full Cast', 'Jim Dale'] }),
        library({ narrators: ['Jim Dale'] }),
      )).toBe('review');
    });
  });

  describe('full-cast edition against a solo-narrator incumbent (#2206)', () => {
    // Durations are MINUTES: 10h33m candidate vs 13h17m incumbent. The 164-minute gap must NOT
    // surface as duration-mismatch — that pins not-equal short-circuiting before the corroborator.
    it('prod specimen: The Golden Compass full-cast edition → different-recording, no review reason', () => {
      expect(resolveRecordingIdentity(
        candidate({ title: 'The Golden Compass', authors: ['Philip Pullman'], narrators: GOLDEN_COMPASS_FULL_CAST, asin: 'B0FULLCAST', duration: 633 }),
        library({ title: 'The Golden Compass', primaryAuthorSlug: 'philip-pullman', narrators: ['Ruth Wilson'], asin: 'B0D9C9BMTW', duration: 797 }),
      )).toEqual({ verdict: 'different-recording' });
    });

    it('negative control: equal survivors, candidate-only placeholder → review / narrator-no-signal', () => {
      expect(resolveRecordingIdentity(
        candidate({ title: 'The Golden Compass', authors: ['Philip Pullman'], narrators: ['Ruth Wilson', 'Full Cast'], asin: 'B0FULLCAST', duration: 633 }),
        library({ title: 'The Golden Compass', primaryAuthorSlug: 'philip-pullman', narrators: ['Ruth Wilson'], asin: 'B0D9C9BMTW', duration: 797 }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'narrator-no-signal' });
    });
  });

  describe('duration corroborator over equal narrator-sets (#1854 absolute 90s band)', () => {
    const eq = { narrators: ['Jim Dale'] };
    const eqLib = { narrators: ['Jim Dale'] };

    // Interface durations are minutes; the resolver converts both to seconds for the shared 240-second band.

    it('missing duration on either side → same-recording', () => {
      expect(verdictOf(candidate(eq), library(eqLib))).toBe('same-recording');
      expect(verdictOf(candidate({ ...eq, duration: 600 }), library(eqLib))).toBe('same-recording');
      expect(verdictOf(candidate(eq), library({ ...eqLib, duration: 600 }))).toBe('same-recording');
    });

    it('zero duration → same-recording', () => {
      expect(verdictOf(candidate({ ...eq, duration: 0 }), library({ ...eqLib, duration: 600 }))).toBe('same-recording');
    });

    it('close duration (Δ ≤ 90s) → same-recording (Tehanu-shaped)', () => {
      // library 600min (36000s) vs candidate 601min (36060s): Δ60s, inside 240s.
      expect(verdictOf(candidate({ ...eq, duration: 601 }), library({ ...eqLib, duration: 600 }))).toBe('same-recording');
    });

    it("Ender's-reissue-shaped (~38 min apart, bundled afterword) → review", () => {
      // library 1140min vs candidate 1178min: Δ38min ≫ 240s.
      expect(verdictOf(candidate({ ...eq, duration: 1178 }), library({ ...eqLib, duration: 1140 }))).toBe('review');
    });

    // Without the conversion, the 240-second constant becomes a 240-minute band; this six-minute gap catches that.
    it('units regression: ~6 min apart (>240s, <240 min) → review, NOT same-recording', () => {
      expect(verdictOf(candidate({ ...eq, duration: 606 }), library({ ...eqLib, duration: 600 }))).toBe('review');
    });

    it('duration never yields different-recording for equal narrators', () => {
      for (const d of [0, 1, 300, 600, 1200]) {
        const verdict = verdictOf(candidate({ ...eq, duration: d }), library({ ...eqLib, duration: 600 }));
        expect(verdict).not.toBe('different-recording');
      }
    });

    // Keep the inclusive 240-second boundary aligned with quality-gate and match-job.
    it('exact 240s boundary → same-recording (inclusive)', () => {
      // candidate 604min = 36240s → Δ240s.
      expect(verdictOf(candidate({ ...eq, duration: 604 }), library({ ...eqLib, duration: 600 }))).toBe('same-recording');
    });

    it('one tick beyond 240s → review', () => {
      // candidate 36241s → Δ241s.
      expect(verdictOf(candidate({ ...eq, duration: 36241 / 60 }), library({ ...eqLib, duration: 600 }))).toBe('review');
    });
  });

  // Production never identifies positively; without duration, a known mismatch only downgrades to review.
  describe('production-type veto on the no-signal-duration branch', () => {
    const eq = { narrators: ['Jim Dale'] };
    const eqLib = { narrators: ['Jim Dale'] };

    it('known mismatch (unabridged vs abridged) + missing duration → review / production-type-mismatch', () => {
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'unabridged' }),
        library({ ...eqLib, productionType: 'abridged' }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'production-type-mismatch' });
    });

    it('known mismatch + zero duration on one side → review / production-type-mismatch', () => {
      expect(resolveRecordingIdentity(
        candidate({ ...eq, duration: 0, productionType: 'unabridged' }),
        library({ ...eqLib, duration: 36000, productionType: 'abridged' }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'production-type-mismatch' });
    });

    it('other known, different pair (unabridged vs full_cast) + no duration → review / production-type-mismatch', () => {
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'unabridged' }),
        library({ ...eqLib, productionType: 'full_cast' }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'production-type-mismatch' });
    });

    it('both unknown + no duration → same-recording (no signal, no veto)', () => {
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'unknown' }),
        library({ ...eqLib, productionType: 'unknown' }),
      )).toEqual({ verdict: 'same-recording' });
    });

    it('same known type + no duration → same-recording', () => {
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'unabridged' }),
        library({ ...eqLib, productionType: 'unabridged' }),
      )).toEqual({ verdict: 'same-recording' });
    });

    it('one side absent (null/omitted) cannot veto → same-recording', () => {
      // Candidate has a known value; omit the library key to cover structural absence before explicit null.
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'abridged' }),
        library(eqLib),
      )).toEqual({ verdict: 'same-recording' });
      expect(resolveRecordingIdentity(
        candidate(eq),
        library({ ...eqLib, productionType: null }),
      )).toEqual({ verdict: 'same-recording' });
    });

    it('duration stays authoritative — corroborating duration ignores a production-type mismatch', () => {
      // Both durations are within 240s (600min vs 601min = Δ60s), so forms may differ.
      expect(resolveRecordingIdentity(
        candidate({ ...eq, duration: 600, productionType: 'unabridged' }),
        library({ ...eqLib, duration: 601, productionType: 'abridged' }),
      )).toEqual({ verdict: 'same-recording' });
    });
  });

  describe('recordingReviewReason is populated for each review path', () => {
    it('duration beyond band → duration-mismatch', () => {
      // 600min vs 700min = Δ100min ≫ 240s.
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Jim Dale'], duration: 600 }),
        library({ narrators: ['Jim Dale'], duration: 700 }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'duration-mismatch' });
    });

    it('no-signal narrator → narrator-no-signal', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Multiple Readers'] }),
        library({ narrators: ['Jim Dale'] }),
      )).toEqual({ verdict: 'review', recordingReviewReason: 'narrator-no-signal' });
    });

    it('non-review verdicts carry no reason', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Jim Dale'] }),
        library({ narrators: ['Jim Dale'] }),
      )).toEqual({ verdict: 'same-recording' });
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Kate Reading', 'Michael Kramer'] }),
        library({ narrators: ['Kate Reading'] }),
      )).toEqual({ verdict: 'different-recording' });
    });
  });
});
