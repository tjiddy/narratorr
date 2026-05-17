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
});
