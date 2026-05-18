import { describe, it, expect } from 'vitest';
import { findInLibraryMatch, normalizeMemberTitleForMatch } from './series-title-match.js';

describe('normalizeMemberTitleForMatch', () => {
  it('case-folds, drops punctuation, collapses whitespace', () => {
    expect(normalizeMemberTitleForMatch('The Wind Through the Keyhole')).toBe('the wind through the keyhole');
    expect(normalizeMemberTitleForMatch('The Wind through the Keyhole')).toBe('the wind through the keyhole');
  });
  it('strips subtitles after the first colon', () => {
    expect(normalizeMemberTitleForMatch('Foo: A Tale of Two Cities')).toBe('foo');
  });
  it('strips parens and brackets', () => {
    expect(normalizeMemberTitleForMatch('Foundation (1951)')).toBe('foundation');
    expect(normalizeMemberTitleForMatch('Foundation [1951]')).toBe('foundation');
  });
  it('strips Unabridged / Audio / Audible edition tails', () => {
    expect(normalizeMemberTitleForMatch('Foo (Unabridged)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audio)')).toBe('foo');
    expect(normalizeMemberTitleForMatch('Foo (Audible)')).toBe('foo');
  });
  it("normalizes curly apostrophes to straight", () => {
    expect(normalizeMemberTitleForMatch("Hitchhiker’s Guide")).toBe("hitchhiker's guide");
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
