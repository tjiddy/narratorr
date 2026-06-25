import { describe, it, expect } from 'vitest';
import type { BookMetadata } from '../../core/metadata/types.js';
import { diceCoefficient } from '../../core/utils/similarity.js';
import {
  matchPassesValidation,
  authorOverlap,
  TITLE_MATCH_THRESHOLD,
  NO_AUTHOR_TITLE_MATCH_THRESHOLD,
} from './match-validation.js';

/**
 * Minimal schema-valid candidate builder. `authors` defaults to a single named
 * author (BookMetadataSchema requires `.min(1)` with a non-empty trimmed name);
 * callers override per case. Fields are omitted (not set to `undefined`) to stay
 * compatible with exactOptionalPropertyTypes — see fixture-builder-eopt-overrides.
 */
function candidate(over: { title: string; authors?: BookMetadata['authors'] }): BookMetadata {
  return {
    title: over.title,
    authors: over.authors ?? [{ name: 'Brandon Sanderson' }],
  } as BookMetadata;
}

describe('matchPassesValidation', () => {
  describe('title dice gate (author present)', () => {
    it('rejects when title dice is below the threshold', () => {
      // Unrelated titles share almost no bigrams (dice ≈ 0.06).
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        candidate({ title: 'Pride and Prejudice' }),
      );
      expect(result).toBe(false);
    });

    it('accepts a 0.70–0.84 title with a matching author (author corroborates a fuzzy title)', () => {
      // Same pair that is rejected title-only below: dice 0.833 clears the loose
      // 0.7 gate, and the matching author is what makes it safe to adopt.
      expect(diceCoefficient('The Lost Hero', 'The Last Hero')).toBeGreaterThanOrEqual(TITLE_MATCH_THRESHOLD);
      const result = matchPassesValidation(
        { title: 'The Lost Hero', author: 'Rick Riordan' },
        candidate({ title: 'The Last Hero', authors: [{ name: 'Rick Riordan' }] }),
      );
      expect(result).toBe(true);
    });

    it('accepts an identical title with a matching author', () => {
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        candidate({ title: 'The Way of Kings' }),
      );
      expect(result).toBe(true);
    });
  });

  describe('verbose/subtitle title containment (author present, #1636)', () => {
    it('accepts a verbose item title against a short candidate (containment, not dice)', () => {
      // The dice branch CANNOT carry this — assert it sits below the gate so the
      // case proves the significant-token containment branch is what passed.
      expect(diceCoefficient('The Hobbit, or There and Back Again', 'The Hobbit')).toBeLessThan(
        TITLE_MATCH_THRESHOLD,
      );
      const result = matchPassesValidation(
        { title: 'The Hobbit, or There and Back Again', author: 'J.R.R. Tolkien' },
        candidate({ title: 'The Hobbit', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(true);
    });

    it('accepts a short item title against a verbose candidate (containment is bidirectional)', () => {
      const result = matchPassesValidation(
        { title: 'The Hobbit', author: 'Tolkien' },
        candidate({ title: 'The Hobbit, or There and Back Again', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(true);
    });

    it('accepts a same-work different-edition title (documented wrong-edition tolerance)', () => {
      // Different audio production, same book — acceptable per #1636 and
      // recoverable via Fix Match. dice is below the gate; containment carries it.
      expect(diceCoefficient('The Hobbit', 'The Hobbit: 50th Anniversary Edition')).toBeLessThan(
        TITLE_MATCH_THRESHOLD,
      );
      const result = matchPassesValidation(
        { title: 'The Hobbit', author: 'Tolkien' },
        candidate({ title: 'The Hobbit: 50th Anniversary Edition', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(true);
    });

    it('rejects a different work by the same author (no shared significant tokens)', () => {
      // dice is also below the gate, so neither branch can carry it.
      expect(diceCoefficient('The Hobbit', 'The Silmarillion')).toBeLessThan(TITLE_MATCH_THRESHOLD);
      const result = matchPassesValidation(
        { title: 'The Hobbit', author: 'Tolkien' },
        candidate({ title: 'The Silmarillion', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(false);
    });

    it('rejects a contained title by a different author (author is confirmed first)', () => {
      // "hobbit" IS contained in "The History of The Hobbit", but the author
      // check (Rateliff ≠ Tolkien) rejects before containment can apply —
      // proves containment never bypasses author corroboration.
      const result = matchPassesValidation(
        { title: 'The Hobbit', author: 'J.R.R. Tolkien' },
        candidate({ title: 'The History of The Hobbit', authors: [{ name: 'John Rateliff' }] }),
      );
      expect(result).toBe(false);
    });

    it('does not treat a stopword-only title as a subset of everything', () => {
      // "The And" reduces to an empty significant-token set; an empty set must
      // NOT satisfy containment, and dice is below the gate → reject.
      expect(diceCoefficient('The And', 'The Hobbit')).toBeLessThan(TITLE_MATCH_THRESHOLD);
      const result = matchPassesValidation(
        { title: 'The And', author: 'Tolkien' },
        candidate({ title: 'The Hobbit', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(false);
    });

    it('does not let a single-character token drive containment', () => {
      // A lone "x" is the item's only token; without the single-char guard it
      // would be a subset of {x, marks, spot}. dice('X', …) is 0, so a reject
      // here proves the guard dropped the single-char token.
      expect(diceCoefficient('X', 'X Marks the Spot')).toBeLessThan(TITLE_MATCH_THRESHOLD);
      const result = matchPassesValidation(
        { title: 'X', author: 'Tolkien' },
        candidate({ title: 'X Marks the Spot', authors: [{ name: 'J.R.R. Tolkien' }] }),
      );
      expect(result).toBe(false);
    });

    it('normalizes punctuation and case (item differing only in punctuation/case passes)', () => {
      const result = matchPassesValidation(
        { title: '  the WAY of kings!!! ', author: 'Brandon Sanderson' },
        candidate({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] }),
      );
      expect(result).toBe(true);
    });
  });

  describe('no-author path — tightened threshold (#1629)', () => {
    it('exposes a stricter no-author threshold than the loose title gate', () => {
      expect(NO_AUTHOR_TITLE_MATCH_THRESHOLD).toBeGreaterThan(TITLE_MATCH_THRESHOLD);
    });

    it('rejects a title-only match in the 0.70–0.84 band (no author corroboration)', () => {
      const item = { title: 'The Lost Hero' };
      const cand = candidate({ title: 'The Last Hero' });
      // Document WHY it's rejected: dice sits in the band that the author path
      // would accept but the no-author path now will not.
      const dice = diceCoefficient(item.title, cand.title);
      expect(dice).toBeGreaterThanOrEqual(TITLE_MATCH_THRESHOLD);
      expect(dice).toBeLessThan(NO_AUTHOR_TITLE_MATCH_THRESHOLD);
      expect(matchPassesValidation(item, cand)).toBe(false);
    });

    it('accepts a near-exact (≥0.85) title-only match', () => {
      const result = matchPassesValidation(
        { title: 'The Way of Kings' },
        candidate({ title: 'The Way of Kings' }),
      );
      expect(result).toBe(true);
    });
  });

  describe('author overlap branches', () => {
    it('full-name overlap is case-insensitive', () => {
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'brandon sanderson' },
        candidate({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] }),
      );
      expect(result).toBe(true);
    });

    it('last-name-only overlap matches (documents known token behavior)', () => {
      // 'John Smith' vs 'Jane Smith' share the 'smith' last-name token.
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'John Smith' },
        candidate({ title: 'The Way of Kings', authors: [{ name: 'Jane Smith' }] }),
      );
      expect(result).toBe(true);
    });

    it('single-initial last token does not overlap a multi-char last name', () => {
      // 'Smith J' (last token 'j', length 1) must not match 'Adams J' on the
      // single-char token — the aLast.length > 1 guard.
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'Smith J' },
        candidate({ title: 'The Way of Kings', authors: [{ name: 'Adams J' }] }),
      );
      expect(result).toBe(false);
    });

    it('rejects when the candidate author name is blank (stripped by filter)', () => {
      // Schema-bypassing fixture: AuthorRefSchema.name is trim().min(1), so a
      // blank name cannot parse — cast past the schema to exercise the defensive
      // filter(Boolean) that drops it, leaving no usable candidate author.
      const cand = { title: 'The Way of Kings', authors: [{ name: '' }] } as unknown as BookMetadata;
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        cand,
      );
      expect(result).toBe(false);
    });

    it('rejects when the candidate authors array is empty (defensive malformed candidate)', () => {
      // BookMetadataSchema.authors is .min(1), so an empty array is not a
      // schema-valid provider candidate — cast past the schema to assert the
      // defensive guard against a malformed candidate.
      const cand = { title: 'The Way of Kings', authors: [] } as unknown as BookMetadata;
      const result = matchPassesValidation(
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        cand,
      );
      expect(result).toBe(false);
    });
  });
});

describe('authorOverlap', () => {
  it('matches identical names ignoring case and surrounding whitespace', () => {
    expect(authorOverlap('  Brandon Sanderson ', 'brandon sanderson')).toBe(true);
  });

  it('matches on a shared multi-char last-name token', () => {
    expect(authorOverlap('John Smith', 'Jane Smith')).toBe(true);
  });

  it('does not match on a single-char last token', () => {
    expect(authorOverlap('Smith J', 'Adams J')).toBe(false);
  });

  it('returns false when either name is blank or whitespace-only', () => {
    expect(authorOverlap('', 'Brandon Sanderson')).toBe(false);
    expect(authorOverlap('Brandon Sanderson', '   ')).toBe(false);
  });
});
