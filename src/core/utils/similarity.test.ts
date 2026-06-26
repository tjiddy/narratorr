import { describe, it, expect } from 'vitest';
import { diceCoefficient, scoreResult, tokenizeNarrators, normalizeNarrator, narratorsFuzzyMatch, compareNarratorSignals, NARRATOR_MATCH_THRESHOLD } from './similarity.js';

describe('diceCoefficient', () => {
  it('returns 1.0 for identical strings', () => {
    expect(diceCoefficient('hello', 'hello')).toBe(1);
  });

  it('returns 1.0 for identical strings regardless of case', () => {
    expect(diceCoefficient('Hello World', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(diceCoefficient('abc', 'xyz')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(diceCoefficient('', '')).toBe(0);
    expect(diceCoefficient('hello', '')).toBe(0);
    expect(diceCoefficient('', 'hello')).toBe(0);
  });

  it('returns 0 for single character strings', () => {
    expect(diceCoefficient('a', 'a')).toBe(0);
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  it('returns partial score for substring matches', () => {
    const score = diceCoefficient('night', 'nightly');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('handles real author name variations', () => {
    // Same author, different ordering
    const score = diceCoefficient('Brandon Sanderson', 'Sanderson, Brandon');
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores similar titles higher than dissimilar ones', () => {
    const similar = diceCoefficient('The Way of Kings', 'Way of Kings');
    const dissimilar = diceCoefficient('The Way of Kings', 'Mistborn');
    expect(similar).toBeGreaterThan(dissimilar);
  });

  it('handles whitespace trimming', () => {
    expect(diceCoefficient('  hello  ', 'hello')).toBe(1);
  });
});

describe('scoreResult', () => {
  it('returns 1.0 for exact title and author match', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(1);
  });

  it('weights title at 0.6 and author at 0.4', () => {
    // Perfect title, no author match
    const titleOnly = scoreResult(
      { title: 'The Way of Kings', author: 'Wrong Author' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Perfect author, no title match
    const authorOnly = scoreResult(
      { title: 'Wrong Title xxxxxxxxx', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Title match should contribute more
    expect(titleOnly).toBeGreaterThan(authorOnly);
  });

  it('uses full weight on title when no author context provided', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings' },
    );
    expect(score).toBe(1);
  });

  it('uses full weight on title when result has no author', () => {
    const score = scoreResult(
      { title: 'The Way of Kings' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(1);
  });

  it('returns 0 when title and author are completely different', () => {
    const score = scoreResult(
      { title: 'xyz abc', author: 'xyz abc' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(0);
  });

  it('returns 0 when no context is provided', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      {},
    );
    expect(score).toBe(0);
  });

  it('scores real-world variation: "Sanderson, Brandon" vs "Brandon Sanderson"', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Sanderson, Brandon' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Should still be a strong match despite name ordering
    expect(score).toBeGreaterThan(0.7);
  });
});

describe('tokenizeNarrators', () => {
  it('splits on comma delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree, Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('splits on semicolon delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree; Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('splits on ampersand delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree & Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('drops empty tokens from consecutive delimiters', () => {
    expect(tokenizeNarrators('Travis Baldree,, Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('drops whitespace-only tokens', () => {
    expect(tokenizeNarrators('A, , B')).toEqual(['A', 'B']);
  });

  it('returns single token when no delimiter', () => {
    expect(tokenizeNarrators('Single Narrator')).toEqual(['Single Narrator']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeNarrators('')).toEqual([]);
  });
});

describe('normalizeNarrator', () => {
  it('strips periods and lowercases', () => {
    expect(normalizeNarrator('Kevin R. Free')).toBe('kevin r free');
  });

  it('lowercases without stripping when no punctuation', () => {
    expect(normalizeNarrator('Kevin R Free')).toBe('kevin r free');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeNarrator('  John   Smith  ')).toBe('john smith');
  });

  it('strips apostrophes', () => {
    expect(normalizeNarrator("O'Brien")).toBe('obrien');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeNarrator('')).toBe('');
  });

  it('returns single character unchanged except lowercase', () => {
    expect(normalizeNarrator('A')).toBe('a');
  });

  it('does NOT strip commas, semicolons, or ampersands', () => {
    // These are delimiters handled by tokenizeNarrators, not normalization
    expect(normalizeNarrator('a,b')).toBe('a,b');
    expect(normalizeNarrator('a;b')).toBe('a;b');
    expect(normalizeNarrator('a&b')).toBe('a&b');
  });

  describe('5A string-cleaning transforms (#1655)', () => {
    it('strips a "Read by:" role prefix (with colon)', () => {
      expect(normalizeNarrator('Read by: P. J. Ochlan')).toBe('pj ochlan');
    });

    it('strips a "Read By" role prefix (no colon)', () => {
      expect(normalizeNarrator('Read By Sissy Spacek')).toBe('sissy spacek');
    });

    it('strips a "Narrated by" role prefix', () => {
      expect(normalizeNarrator('Narrated by Paul Boehmer')).toBe('paul boehmer');
    });

    it('drops a parenthetical descriptor', () => {
      expect(normalizeNarrator('James Marsters (Spike from Buffy The Vampire Slayer)')).toBe('james marsters');
    });

    it('folds diacritics (NFD + combining-mark strip)', () => {
      expect(normalizeNarrator('Thérèse Plummer')).toBe('therese plummer');
    });

    it('canonicalizes initials: spaced "R. C." and unspaced "R.C." converge', () => {
      expect(normalizeNarrator('R. C. Bray')).toBe('rc bray');
      expect(normalizeNarrator('R.C. Bray')).toBe('rc bray');
      expect(normalizeNarrator('R. C. Bray')).toBe(normalizeNarrator('R.C. Bray'));
    });

    it('collapses a 3-initial run without touching the surname', () => {
      // J.R.R. Tolkien — both spaced and unspaced forms reduce identically.
      expect(normalizeNarrator('J. R. R. Tolkien')).toBe('jrr tolkien');
      expect(normalizeNarrator('J.R.R. Tolkien')).toBe('jrr tolkien');
    });

    it('does NOT collapse a real two-word name into initials (Jo Anna)', () => {
      expect(normalizeNarrator('Jo Anna')).toBe('jo anna');
    });
  });

  describe('5A bare-prefix guard — never empties a token (#1655)', () => {
    // Role-prefix strip is non-destructive: a prefix-only value normalizes to
    // itself (non-empty), proving the placeholder/no-signal call is NOT in the
    // global string primitive — it lives at the comparison layer (5B).
    it('leaves a bare "Narrator" intact', () => {
      expect(normalizeNarrator('Narrator')).toBe('narrator');
    });

    it('leaves a bare "Voice" intact', () => {
      expect(normalizeNarrator('Voice')).toBe('voice');
    });

    it('leaves a bare "Read by" intact (prefix with no following name)', () => {
      expect(normalizeNarrator('Read by')).toBe('read by');
    });

    it('leaves the "Author" placeholder as a non-empty token', () => {
      expect(normalizeNarrator('Author')).toBe('author');
    });

    it('does NOT partial-match a prefix inside a longer word (word boundary)', () => {
      // `voice` must not strip from `Voiceover`, nor `narrator` from `Narrators`.
      expect(normalizeNarrator('Voiceover Artist')).toBe('voiceover artist');
      expect(normalizeNarrator('Narrators Guild')).toBe('narrators guild');
    });
  });
});

describe('narratorsFuzzyMatch (#1650)', () => {
  it('exposes the 0.8 default threshold as the single source of truth', () => {
    expect(NARRATOR_MATCH_THRESHOLD).toBe(0.8);
  });

  it('returns true for a spelling variant at or above threshold (dice ≈ 0.875)', () => {
    expect(narratorsFuzzyMatch('Juliet Stevenson', ['Juliette Stevenson'])).toBe(true);
  });

  it('returns true when normalization collapses punctuation noise (Ray Porter / Ray. Porter)', () => {
    expect(narratorsFuzzyMatch('Ray Porter', ['Ray. Porter'])).toBe(true);
  });

  it('returns false for a bare-surname variant below threshold (dice ≈ 0.706)', () => {
    // Documents the design contract: no phonetic/alias layer — Stevenson/Stephenson
    // scores below 0.8 and is (correctly) treated as a mismatch.
    expect(narratorsFuzzyMatch('Stevenson', ['Stephenson'])).toBe(false);
  });

  it('returns false for distinct narrators (wrong-edition headline)', () => {
    expect(narratorsFuzzyMatch('Adriel Brandt', ['Michael York'])).toBe(false);
  });

  it('set-overlap: any file token matching any edition narrator satisfies the match', () => {
    expect(narratorsFuzzyMatch('Ethan Hawke', ['James Franco', 'Ethan Hawke'])).toBe(true);
    expect(narratorsFuzzyMatch('Ethan Hawke', ['James Franco', 'Tatiana Maslany'])).toBe(false);
  });

  it('splits a multi-value file narrator string on delimiters', () => {
    expect(narratorsFuzzyMatch('Ethan Hawke, James Franco', ['James Franco'])).toBe(true);
  });

  it('returns false when the file narrator has no signal', () => {
    expect(narratorsFuzzyMatch(undefined, ['Michael York'])).toBe(false);
    expect(narratorsFuzzyMatch('', ['Michael York'])).toBe(false);
    expect(narratorsFuzzyMatch('   ', ['Michael York'])).toBe(false);
  });

  it('returns false when the edition has no narrators', () => {
    expect(narratorsFuzzyMatch('Adriel Brandt', undefined)).toBe(false);
    expect(narratorsFuzzyMatch('Adriel Brandt', [])).toBe(false);
    expect(narratorsFuzzyMatch('Adriel Brandt', ['   '])).toBe(false);
  });

  it('honors a caller-supplied threshold override', () => {
    // Stevenson/Stephenson scores ≈ 0.706 — clears a relaxed 0.7 bar.
    expect(narratorsFuzzyMatch('Stevenson', ['Stephenson'], 0.7)).toBe(true);
  });

  it('treats the 0.8 threshold as INCLUSIVE — a score of exactly 0.8 matches (#1652)', () => {
    // `abcdef` vs `abcdeg` share 4 of 5 bigrams → dice = 2*4/(5+5) = exactly 0.8.
    // Locks the `>=` boundary: a `>=`→`>` regression would flip this to false.
    expect(diceCoefficient('abcdef', 'abcdeg')).toBe(0.8);
    expect(narratorsFuzzyMatch('abcdef', ['abcdeg'], 0.8)).toBe(true);
  });

  it('is order-insensitive — a Last, First flip still matches (#1652)', () => {
    // `Stevenson, Juliet` vs `Juliet Stevenson`: the as-is dice ≈ 0.696 (below
    // 0.8), but the token-sorted compare lines the words up → match.
    expect(narratorsFuzzyMatch('Stevenson, Juliet', ['Juliet Stevenson'])).toBe(true);
  });

  it('does NOT force abbreviation/initial expansion (Mike/Michael stays a mismatch — #1652)', () => {
    // Word-order is in scope; phonetic/abbreviation expansion is explicitly out.
    expect(narratorsFuzzyMatch('Mike', ['Michael'])).toBe(false);
  });

  describe('5A noise resolves the 6 non-placeholder false positives (#1655)', () => {
    // The UAT false-positive fixture: same person on both sides, sunk previously
    // by tag noise the normalizer now folds. Each must fuzzy-MATCH (no cap).
    it('initials spacing — "R. C. Bray" ↔ "R.C. Bray"', () => {
      expect(narratorsFuzzyMatch('R. C. Bray', ['R.C. Bray'])).toBe(true);
    });

    it('role prefix with colon — "Read by: P. J. Ochlan" ↔ "P. J. Ochlan"', () => {
      expect(narratorsFuzzyMatch('Read by: P. J. Ochlan', ['P. J. Ochlan'])).toBe(true);
    });

    it('role prefix no colon — "Read By Sissy Spacek" ↔ "Sissy Spacek"', () => {
      expect(narratorsFuzzyMatch('Read By Sissy Spacek', ['Sissy Spacek'])).toBe(true);
    });

    it('role prefix "Narrated by" — "Narrated by Paul Boehmer" ↔ "Paul Boehmer"', () => {
      expect(narratorsFuzzyMatch('Narrated by Paul Boehmer', ['Paul Boehmer'])).toBe(true);
    });

    it('parenthetical descriptor — "James Marsters (Spike…)" ↔ "James Marsters"', () => {
      expect(
        narratorsFuzzyMatch('James Marsters (Spike from Buffy The Vampire Slayer)', ['James Marsters']),
      ).toBe(true);
    });

    it('diacritics — "Therese Plummer" ↔ "Thérèse Plummer"', () => {
      expect(narratorsFuzzyMatch('Therese Plummer', ['Thérèse Plummer'])).toBe(true);
    });
  });
});

describe('compareNarratorSignals (3-state, #1650/#1652)', () => {
  it('returns "no-signal" for punctuation-only narrators on both sides (lone hyphen vs period)', () => {
    // The #1652 headline: `'-'` and `'.'` both normalize to empty, so there is no
    // usable signal — NOT a mismatch. The file-side guard and the primitive agree.
    expect(compareNarratorSignals('-', ['.'])).toBe('no-signal');
  });

  it('returns "no-signal" when the file narrator is absent or whitespace-only', () => {
    expect(compareNarratorSignals(undefined, ['Michael York'])).toBe('no-signal');
    expect(compareNarratorSignals('', ['Michael York'])).toBe('no-signal');
    expect(compareNarratorSignals('   ', ['Michael York'])).toBe('no-signal');
  });

  it('returns "no-signal" when the edition has no usable narrators', () => {
    expect(compareNarratorSignals('Adriel Brandt', undefined)).toBe('no-signal');
    expect(compareNarratorSignals('Adriel Brandt', [])).toBe('no-signal');
    expect(compareNarratorSignals('Adriel Brandt', ['   ', '.'])).toBe('no-signal');
  });

  it('returns "match" when a file token clears the threshold against any edition narrator', () => {
    expect(compareNarratorSignals('Michael York', ['Michael York'])).toBe('match');
    expect(compareNarratorSignals('Ethan Hawke', ['James Franco', 'Ethan Hawke'])).toBe('match');
  });

  it('returns "mismatch" when both sides carry signal but nothing clears the threshold', () => {
    expect(compareNarratorSignals('Adriel Brandt', ['Michael York'])).toBe('mismatch');
  });

  describe('5B placeholder denylist → "no-signal", NOT "mismatch" (#1655)', () => {
    // Junk file tags carry no usable signal even though they normalize to a
    // non-empty string. The two UAT placeholder fixtures plus the full denylist
    // set must collapse to no-signal (no cap) — asserted at THIS layer, never
    // via narratorsFuzzyMatch (which can't distinguish no-signal from mismatch).
    it('"Multiple Readers" against a real full-cast edition is no-signal (Hyperion fixture)', () => {
      expect(
        compareNarratorSignals('Multiple Readers', [
          'Marc Vietor',
          'Allyson Johnson',
          'Kevin Pariseau',
          'Jay Snyder',
          'Victor Bevine',
        ]),
      ).toBe('no-signal');
    });

    it('"Author" against a real narrator is no-signal (1776 fixture)', () => {
      expect(compareNarratorSignals('Author', ['David McCullough'])).toBe('no-signal');
    });

    it('the full denylist set (incl. literal "narrator") is no-signal against a real edition', () => {
      const denylist = [
        'Author',
        'Multiple Readers',
        'Various',
        'Various Narrators',
        'Full Cast',
        'Unknown',
        'Uncredited',
        'Narrator',
      ];
      for (const placeholder of denylist) {
        expect(compareNarratorSignals(placeholder, ['David McCullough'])).toBe('no-signal');
      }
    });

    it('drops only the placeholder token from a mixed file tag, keeping the real name', () => {
      // `Various, Ray Porter` — `various` is dropped, `Ray Porter` still matches.
      expect(compareNarratorSignals('Various, Ray Porter', ['Ray Porter'])).toBe('match');
    });

    it('placeholder on the EDITION side is also dropped → no-signal', () => {
      expect(compareNarratorSignals('Ray Porter', ['Full Cast'])).toBe('no-signal');
    });
  });
});

describe('over-reach guard — pins current behavior, NOT hardening (#1657)', () => {
  // The 5A/5B blocks prove noise → clean. These pin that the same transforms did
  // NOT start matching different people OR drop real names. Every assertion below
  // is the CURRENT, verified output — a future tightening must change these on
  // purpose, test-visibly. Behavior-changing hardening is deferred (see #1657
  // Out of Scope).

  describe('different-middle-initial — accepted collapseInitials over-match', () => {
    // Same first-initial + same surname + 1-char-different middle initial. The
    // word-sorted leg of nameDice clears 0.8 once collapseInitials joins the run,
    // so these read as 'match'. This is the accepted trade-off documented on
    // collapseInitials — pin it as a match (NOT a mismatch), so removing it later
    // is a conscious decision.
    it('R. C. Bray vs R. K. Bray is a match (over-match accepted)', () => {
      expect(compareNarratorSignals('R. C. Bray', ['R. K. Bray'])).toBe('match');
    });

    it('P. J. Ochlan vs P. T. Ochlan is a match (over-match accepted)', () => {
      expect(compareNarratorSignals('P. J. Ochlan', ['P. T. Ochlan'])).toBe('match');
    });
  });

  describe('real name containing a denied placeholder token is KEPT', () => {
    // The 5B denylist is exact-set membership, not substring — `Authorson`
    // contains `author` but is real signal, never dropped.
    it('normalizeNarrator keeps "Authorson"', () => {
      expect(normalizeNarrator('Authorson')).toBe('authorson');
    });

    it('"Authorson" is treated as real signal and matches itself', () => {
      expect(compareNarratorSignals('Authorson', ['Authorson'])).toBe('match');
    });
  });

  describe('role-word-first-name — current 5A behavior (vanishingly rare)', () => {
    // A real first name that happens to be a bare role word is consumed by the
    // role-prefix strip. Pinned as current behavior; requiring a `by`/`:` suffix
    // is deferred (#1657 Out of Scope).
    it('normalizeNarrator("Voice Carter") → "carter"', () => {
      expect(normalizeNarrator('Voice Carter')).toBe('carter');
    });

    it('normalizeNarrator("Narrator Jones") → "jones"', () => {
      expect(normalizeNarrator('Narrator Jones')).toBe('jones');
    });
  });

  describe('parenthetical disambiguator — current global-strip behavior', () => {
    // normalizeNarrator strips ALL parentheticals (global /\([^)]*\)/g), trailing
    // OR embedded. Switching to a trailing-only strip is deferred (#1657 Out of
    // Scope) — pin the current global behavior.
    it('strips a trailing disambiguator', () => {
      expect(normalizeNarrator('James Marsters (Spike from Buffy)')).toBe('james marsters');
    });

    it('strips an embedded parenthetical alias too', () => {
      expect(normalizeNarrator('Robert (Bob) Smith')).toBe('robert smith');
    });
  });
});
