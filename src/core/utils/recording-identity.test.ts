import { describe, it, expect } from 'vitest';
import {
  compareRecordingNarrators,
  resolveRecordingIdentity,
  deriveEditionLabel,
  type RecordingCandidate,
  type LibraryRecording,
  type RecordingVerdict,
} from './recording-identity.js';

describe('compareRecordingNarrators (#1710)', () => {
  it('equal sets → equal', () => {
    expect(compareRecordingNarrators(['Jim Dale'], ['Jim Dale'])).toBe('equal');
    expect(compareRecordingNarrators(['A', 'B'], ['B', 'A'])).toBe('equal'); // order-insensitive
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

  // (#1729 gap c) The label is the RAW trimmed name, not the normalized signal —
  // it is a human-facing edition discriminator, so a parenthetical or role-prefix
  // is signal for the no-signal check (via normalizeNarrator) but is preserved
  // verbatim in the returned label. Pinning the exact string guards the documented
  // "a rescan re-derives the same label" stability against a future normalize-the-label change.
  it('returns the raw label for a parenthetical name (divergent from the normalized form)', () => {
    // normalizeNarrator strips the parenthetical to 'james marsters' (signal), so the
    // raw branch is reached and the parenthetical survives in the returned label.
    expect(deriveEditionLabel(['James Marsters (Spike)'])).toBe('James Marsters (Spike)');
  });

  it('returns the raw label for a role-prefixed name (divergent from the normalized form)', () => {
    // normalizeNarrator strips the 'Narrator:' role prefix to 'jim dale' (signal), so the
    // raw branch is reached and the prefix survives in the returned label.
    expect(deriveEditionLabel(['Narrator: Jim Dale'])).toBe('Narrator: Jim Dale');
  });
});

// ── Resolver ────────────────────────────────────────────────────────────

function candidate(overrides: Partial<RecordingCandidate> = {}): RecordingCandidate {
  return { title: 'T', authors: ['Author One'], narrators: [], ...overrides };
}

function library(overrides: Partial<LibraryRecording> = {}): LibraryRecording {
  return { title: 'T', primaryAuthorSlug: 'author-one', narrators: [], ...overrides };
}

/**
 * Verdict-only convenience (#1728). The resolver now returns
 * `{ verdict, recordingReviewReason? }`; the many verdict-only assertions below
 * read just the verdict through this helper. The reason-flow tests further down
 * call `resolveRecordingIdentity` directly and assert on both fields.
 */
function verdictOf(c: RecordingCandidate, e: LibraryRecording): RecordingVerdict {
  return resolveRecordingIdentity(c, e).verdict;
}

describe('resolveRecordingIdentity (#1710)', () => {
  it('ASIN-equal short-circuits to same-recording (case-insensitive)', () => {
    const verdict = verdictOf(
      candidate({ asin: 'b01abc', narrators: ['X'] }),
      library({ asin: 'B01ABC', narrators: ['Y'] }), // narrators differ; ASIN wins
    );
    expect(verdict).toBe('same-recording');
  });

  it('different ASIN does NOT short-circuit — defers to narrator (Tehanu)', () => {
    const verdict = verdictOf(
      candidate({ asin: 'B-NEW', title: 'Tehanu', authors: ['Ursula K. Le Guin'], narrators: ['Jenny Sterlin'], duration: 36000 }),
      library({ asin: 'B-OLD', title: 'Tehanu', primaryAuthorSlug: 'ursula-k-le-guin', narrators: ['Jenny Sterlin'], duration: 36100 }),
    );
    expect(verdict).toBe('same-recording');
  });

  // (#1729 gap a) The ASIN guard is `if (candidate.asin && entry.asin && …)` — a
  // ONE-sided ASIN must NOT short-circuit on the ASIN branch; it falls through to
  // the title + primary-author scope and the narrator predicate. Both existing ASIN
  // tests set the ASIN on both sides, leaving the single-sided fall-through unpinned.
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

  // (#1729 gap b) DECISION: the candidate ASIN is canonicalized (trim + UPPERCASE
  // via the shared `canonicalizeAsin`, #1733) before the resolver's ASIN compare,
  // so a padded/case-drifted pre-write candidate still matches a stored canonical
  // ASIN. The same decision is applied at the earlier `gatherIncumbentIds` site
  // (see book.service.dedup.integration.test.ts) so the two sites cannot drift.
  // Narrators are deliberately not-equal here so ONLY the ASIN branch could yield
  // same-recording — a non-canonicalizing resolver would fall through to
  // different-recording.
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
    // matching title but different author slug also falls through to different-recording
    expect(verdictOf(
      candidate({ authors: ['Someone Else'], narrators: ['X'] }),
      library({ primaryAuthorSlug: 'author-one', narrators: ['X'] }),
    )).toBe('different-recording');
  });

  describe('author-less records never pass the author scope (#1722)', () => {
    it('both author-less with normalize-equal titles → different-recording (equal narrators)', () => {
      // Equal narrators would resolve same-recording if the empty-slug pair passed the scope.
      expect(verdictOf(
        candidate({ title: 'The Stranger', authors: [], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('author-less candidate vs authored entry → different-recording', () => {
      expect(verdictOf(
        candidate({ title: 'The Stranger', authors: [], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: 'author-one', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('authored candidate vs author-less entry → different-recording', () => {
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
        candidate({ narrators: ['Kate Reading, Michael Kramer'], duration: 36000 }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'], duration: 39000 }),
      )).toBe('same-recording');
    });

    it('previously-different-recording packed case now flips to same-recording (Bug-1 repair)', () => {
      // Before the tokenize fix, the packed candidate had set size 1 vs the split
      // library set size 2 → not-equal → different-recording. It must now match.
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

  describe('duration corroborator over equal narrator-sets', () => {
    const eq = { narrators: ['Jim Dale'] };
    const eqLib = { narrators: ['Jim Dale'] };

    it('missing duration on either side → same-recording', () => {
      expect(verdictOf(candidate(eq), library(eqLib))).toBe('same-recording');
      expect(verdictOf(candidate({ ...eq, duration: 36000 }), library(eqLib))).toBe('same-recording');
      expect(verdictOf(candidate(eq), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('zero duration → same-recording', () => {
      expect(verdictOf(candidate({ ...eq, duration: 0 }), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('close duration (within 15%) → same-recording', () => {
      expect(verdictOf(candidate({ ...eq, duration: 36000 }), library({ ...eqLib, duration: 39000 }))).toBe('same-recording');
    });

    it('far-apart duration (beyond 15%) → review', () => {
      expect(verdictOf(candidate({ ...eq, duration: 18000 }), library({ ...eqLib, duration: 36000 }))).toBe('review');
    });

    it('duration never yields different-recording for equal narrators', () => {
      for (const d of [0, 1, 18000, 36000, 100000]) {
        const verdict = verdictOf(candidate({ ...eq, duration: d }), library({ ...eqLib, duration: 36000 }));
        expect(verdict).not.toBe('different-recording');
      }
    });

    // (#1729 gap d) The corroborator uses `distance <= DURATION_TOLERANCE` (0.15) —
    // INCLUSIVE at the edge. Existing cases only cover well-inside (8.3%) and
    // far-outside (50%); pin the exact 0.15 boundary and one tick beyond, on both
    // the shorter-candidate and longer-candidate sides of the band. Library 36000,
    // band edge Δ = 36000 * 0.15 = 5400 → 30600 (short) / 41400 (long).
    it('exact 15% boundary on the shorter-candidate side → same-recording (inclusive)', () => {
      expect(verdictOf(candidate({ ...eq, duration: 30600 }), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('one tick beyond 15% on the shorter-candidate side → review', () => {
      expect(verdictOf(candidate({ ...eq, duration: 30599 }), library({ ...eqLib, duration: 36000 }))).toBe('review');
    });

    it('exact 15% boundary on the longer-candidate side → same-recording (inclusive)', () => {
      expect(verdictOf(candidate({ ...eq, duration: 41400 }), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('one tick beyond 15% on the longer-candidate side → review', () => {
      expect(verdictOf(candidate({ ...eq, duration: 41401 }), library({ ...eqLib, duration: 36000 }))).toBe('review');
    });
  });

  // (#1728) Production-type veto toward the SAFE review disposition — only on the
  // equal-narrator + no-corroborating-duration branch. `production_type` never
  // becomes a positive identity signal; a known-mismatch only downgrades an
  // otherwise-`same-recording` to `review`. Asserts on BOTH the verdict and the
  // machine `recordingReviewReason`.
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
      // Candidate has a known value, library omits it entirely (per the eopt
      // fixture-builder learning: OMIT the key, do not pass `undefined`).
      expect(resolveRecordingIdentity(
        candidate({ ...eq, productionType: 'abridged' }),
        library(eqLib),
      )).toEqual({ verdict: 'same-recording' });
      // Explicit null on the other side is equally no-signal.
      expect(resolveRecordingIdentity(
        candidate(eq),
        library({ ...eqLib, productionType: null }),
      )).toEqual({ verdict: 'same-recording' });
    });

    it('duration stays authoritative — corroborating duration ignores a production-type mismatch', () => {
      // Both durations within band → same-recording even though forms differ.
      expect(resolveRecordingIdentity(
        candidate({ ...eq, duration: 36000, productionType: 'unabridged' }),
        library({ ...eqLib, duration: 39000, productionType: 'abridged' }),
      )).toEqual({ verdict: 'same-recording' });
    });
  });

  // (#1728) Reason-flow contract: every `review` path carries its machine reason.
  describe('recordingReviewReason is populated for each review path', () => {
    it('duration beyond band → duration-mismatch', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Jim Dale'], duration: 18000 }),
        library({ narrators: ['Jim Dale'], duration: 36000 }),
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
