import { describe, it, expect } from 'vitest';
import {
  compareRecordingNarrators,
  resolveRecordingIdentity,
  deriveEditionLabel,
  type RecordingCandidate,
  type LibraryRecording,
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
});

// ── Resolver ────────────────────────────────────────────────────────────

function candidate(overrides: Partial<RecordingCandidate> = {}): RecordingCandidate {
  return { title: 'T', authors: ['Author One'], narrators: [], ...overrides };
}

function library(overrides: Partial<LibraryRecording> = {}): LibraryRecording {
  return { title: 'T', primaryAuthorSlug: 'author-one', narrators: [], ...overrides };
}

describe('resolveRecordingIdentity (#1710)', () => {
  it('ASIN-equal short-circuits to same-recording (case-insensitive)', () => {
    const verdict = resolveRecordingIdentity(
      candidate({ asin: 'b01abc', narrators: ['X'] }),
      library({ asin: 'B01ABC', narrators: ['Y'] }), // narrators differ; ASIN wins
    );
    expect(verdict).toBe('same-recording');
  });

  it('different ASIN does NOT short-circuit — defers to narrator (Tehanu)', () => {
    const verdict = resolveRecordingIdentity(
      candidate({ asin: 'B-NEW', title: 'Tehanu', authors: ['Ursula K. Le Guin'], narrators: ['Jenny Sterlin'], duration: 36000 }),
      library({ asin: 'B-OLD', title: 'Tehanu', primaryAuthorSlug: 'ursula-k-le-guin', narrators: ['Jenny Sterlin'], duration: 36100 }),
    );
    expect(verdict).toBe('same-recording');
  });

  it('crux: HP single narrator vs full-cast superset → different-recording', () => {
    const verdict = resolveRecordingIdentity(
      candidate({ title: "Harry Potter and the Sorcerer's Stone", authors: ['J. K. Rowling'], narrators: ['Jim Dale', 'Extra Cast Member'] }),
      library({ title: "Harry Potter and the Sorcerer's Stone", primaryAuthorSlug: 'j-k-rowling', narrators: ['Jim Dale'] }),
    );
    expect(verdict).toBe('different-recording');
  });

  it('no-signal narrator (placeholder / unknown) → review', () => {
    const verdict = resolveRecordingIdentity(
      candidate({ narrators: ['Multiple Readers'] }),
      library({ narrators: ['Jim Dale'] }),
    );
    expect(verdict).toBe('review');
  });

  it('not-equal/superset under matching title+author → different-recording', () => {
    const verdict = resolveRecordingIdentity(
      candidate({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      library({ narrators: ['Kate Reading'] }),
    );
    expect(verdict).toBe('different-recording');
  });

  it('no title+author match → different-recording (new book)', () => {
    expect(resolveRecordingIdentity(
      candidate({ title: 'Wholly Different', narrators: ['X'] }),
      library({ title: 'Original', narrators: ['X'] }),
    )).toBe('different-recording');
    // matching title but different author slug also falls through to different-recording
    expect(resolveRecordingIdentity(
      candidate({ authors: ['Someone Else'], narrators: ['X'] }),
      library({ primaryAuthorSlug: 'author-one', narrators: ['X'] }),
    )).toBe('different-recording');
  });

  describe('author-less records never pass the author scope (#1722)', () => {
    it('both author-less with normalize-equal titles → different-recording (equal narrators)', () => {
      // Equal narrators would resolve same-recording if the empty-slug pair passed the scope.
      expect(resolveRecordingIdentity(
        candidate({ title: 'The Stranger', authors: [], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('author-less candidate vs authored entry → different-recording', () => {
      expect(resolveRecordingIdentity(
        candidate({ title: 'The Stranger', authors: [], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: 'author-one', narrators: ['X'] }),
      )).toBe('different-recording');
    });

    it('authored candidate vs author-less entry → different-recording', () => {
      expect(resolveRecordingIdentity(
        candidate({ title: 'The Stranger', authors: ['Author One'], narrators: ['X'] }),
        library({ title: 'The Stranger', primaryAuthorSlug: '', narrators: ['X'] }),
      )).toBe('different-recording');
    });
  });

  describe('title-normalization drift scopes to the same incumbent', () => {
    it('colon subtitle (Mistborn: The Final Empire vs Mistborn)', () => {
      const verdict = resolveRecordingIdentity(
        candidate({ title: 'Mistborn: The Final Empire', narrators: ['Michael Kramer'] }),
        library({ title: 'Mistborn', narrators: ['Michael Kramer'] }),
      );
      expect(verdict).toBe('same-recording');
    });

    it('trailing parenthetical (Dune (Unabridged) vs Dune)', () => {
      const verdict = resolveRecordingIdentity(
        candidate({ title: 'Dune (Unabridged)', narrators: ['Scott Brick'] }),
        library({ title: 'Dune', narrators: ['Scott Brick'] }),
      );
      expect(verdict).toBe('same-recording');
    });

    it('series-marker drift (Foo, Book 1 vs Foo)', () => {
      const verdict = resolveRecordingIdentity(
        candidate({ title: 'Foo, Book 1', narrators: ['Scott Brick'] }),
        library({ title: 'Foo', narrators: ['Scott Brick'] }),
      );
      expect(verdict).toBe('same-recording');
    });
  });

  describe('packed + one-sided-placeholder narrator shapes (#1725)', () => {
    it('comma-packed candidate vs split library, absent duration → same-recording', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Kate Reading, Michael Kramer'] }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('same-recording');
    });

    it('comma-packed candidate vs split library, close duration → same-recording', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Kate Reading, Michael Kramer'], duration: 36000 }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'], duration: 39000 }),
      )).toBe('same-recording');
    });

    it('previously-different-recording packed case now flips to same-recording (Bug-1 repair)', () => {
      // Before the tokenize fix, the packed candidate had set size 1 vs the split
      // library set size 2 → not-equal → different-recording. It must now match.
      expect(compareRecordingNarrators(['Kate Reading, Michael Kramer'], ['Kate Reading', 'Michael Kramer'])).toBe('equal');
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Kate Reading, Michael Kramer'] }),
        library({ narrators: ['Kate Reading', 'Michael Kramer'] }),
      )).toBe('same-recording');
    });

    it('lead-plus-fullcast candidate vs lead library → review, NOT same-recording (Bug-2 guard)', () => {
      expect(resolveRecordingIdentity(
        candidate({ narrators: ['Full Cast', 'Jim Dale'] }),
        library({ narrators: ['Jim Dale'] }),
      )).toBe('review');
    });
  });

  describe('duration corroborator over equal narrator-sets', () => {
    const eq = { narrators: ['Jim Dale'] };
    const eqLib = { narrators: ['Jim Dale'] };

    it('missing duration on either side → same-recording', () => {
      expect(resolveRecordingIdentity(candidate(eq), library(eqLib))).toBe('same-recording');
      expect(resolveRecordingIdentity(candidate({ ...eq, duration: 36000 }), library(eqLib))).toBe('same-recording');
      expect(resolveRecordingIdentity(candidate(eq), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('zero duration → same-recording', () => {
      expect(resolveRecordingIdentity(candidate({ ...eq, duration: 0 }), library({ ...eqLib, duration: 36000 }))).toBe('same-recording');
    });

    it('close duration (within 15%) → same-recording', () => {
      expect(resolveRecordingIdentity(candidate({ ...eq, duration: 36000 }), library({ ...eqLib, duration: 39000 }))).toBe('same-recording');
    });

    it('far-apart duration (beyond 15%) → review', () => {
      expect(resolveRecordingIdentity(candidate({ ...eq, duration: 18000 }), library({ ...eqLib, duration: 36000 }))).toBe('review');
    });

    it('duration never yields different-recording for equal narrators', () => {
      for (const d of [0, 1, 18000, 36000, 100000]) {
        const verdict = resolveRecordingIdentity(candidate({ ...eq, duration: d }), library({ ...eqLib, duration: 36000 }));
        expect(verdict).not.toBe('different-recording');
      }
    });
  });
});
