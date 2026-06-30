import { describe, it, expect } from 'vitest';
import { normalizeTitleForDedup, matchesLibraryIdentity, type DedupIdentity } from './dedup.js';

describe('normalizeTitleForDedup', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeTitleForDedup('  The   Way  Of Kings ')).toBe('the way of kings');
  });

  it('strips a colon subtitle when the prefix is ≥3 non-space chars', () => {
    expect(normalizeTitleForDedup('Tehanu: The Last Book of Earthsea')).toBe('tehanu');
  });

  it('does NOT strip a colon subtitle when the prefix is 1–2 chars', () => {
    expect(normalizeTitleForDedup('IT: Chapter Two')).toBe('it: chapter two');
    expect(normalizeTitleForDedup('X: Marks')).toBe('x: marks');
  });

  it('does NOT strip when the colon is at position 0', () => {
    expect(normalizeTitleForDedup(': leading colon')).toBe(': leading colon');
  });

  it('strips a trailing parenthetical series/edition group', () => {
    expect(normalizeTitleForDedup('The Farthest Shore (The Earthsea Cycle Book 3)')).toBe('the farthest shore');
  });

  it('strips a trailing `, Book N` series marker', () => {
    expect(normalizeTitleForDedup('Shattered Sea, Book 1')).toBe('shattered sea');
  });

  it('strips a trailing `, Vol N` / ` Volume N` series marker', () => {
    expect(normalizeTitleForDedup('Saga, Vol 2')).toBe('saga');
    expect(normalizeTitleForDedup('Berserk Volume 5')).toBe('berserk');
  });

  it('is idempotent on already-clean titles', () => {
    expect(normalizeTitleForDedup('the way of kings')).toBe('the way of kings');
    expect(normalizeTitleForDedup(normalizeTitleForDedup('Tehanu: X'))).toBe('tehanu');
  });
});

describe('matchesLibraryIdentity', () => {
  const owned: DedupIdentity = { title: 'Tehanu', asin: 'B01G9EPERE', authorSlug: 'ursula-k-le-guin' };

  it('matches by ASIN case-insensitively', () => {
    expect(matchesLibraryIdentity({ title: 'Different', asin: 'b01g9epere' }, owned)).toBe(true);
  });

  // #1726 — the ASIN arm is canonicalized (trim + UPPERCASE via the shared
  // `canonicalizeAsin`) so all three homes share one ASIN contract. A padded/case-
  // drifted candidate folds to the stored canonical form and still matches.
  it('matches a whitespace-padded, case-drifted ASIN via canonicalizeAsin (#1726)', () => {
    expect(matchesLibraryIdentity({ title: 'Different', asin: '  b01g9epere  ' }, owned)).toBe(true);
  });

  it('folds a whitespace-only ASIN to "no ASIN" and falls through to the title/author ladder (#1726)', () => {
    // The blank ASIN must not match on the ASIN arm; the title/author ladder decides.
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: a subtitle', asin: '   ', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true); // falls through → title+author match
    expect(matchesLibraryIdentity(
      { title: 'Brand New Book', asin: '   ', authorName: 'New Author' },
      owned,
    )).toBe(false); // falls through → no title/author match, blank ASIN never matched
  });

  it('ASIN takes precedence over title/author', () => {
    expect(matchesLibraryIdentity(
      { title: 'Completely Other', asin: 'B01G9EPERE', authorName: 'Someone Else' },
      owned,
    )).toBe(true);
  });

  it('falls back to normalized title + author slug on an ASIN miss (different edition)', () => {
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: The Last Book of Earthsea', asin: 'B0DIFFEDIT', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true);
  });

  it('matches on colon/parenthetical/case drift ONLY when the author slug matches', () => {
    expect(matchesLibraryIdentity(
      { title: 'TEHANU: a subtitle', authorName: 'Ursula K. Le Guin' },
      owned,
    )).toBe(true);
  });

  it('does NOT match a title-drift hit when the author slug differs', () => {
    expect(matchesLibraryIdentity(
      { title: 'Tehanu: a subtitle', authorName: 'Some Other Author' },
      owned,
    )).toBe(false);
  });

  it('author-less title-only matches exactly and does NOT subtitle-strip', () => {
    const authorless: DedupIdentity = { title: 'Tehanu', asin: null, authorSlug: null };
    expect(matchesLibraryIdentity({ title: 'Tehanu', asin: null }, authorless)).toBe(true);
    expect(matchesLibraryIdentity({ title: 'Tehanu: X', asin: null }, authorless)).toBe(false);
  });

  it('does not match when one side is authored and the other author-less', () => {
    const authorless: DedupIdentity = { title: 'Tehanu', asin: null, authorSlug: null };
    expect(matchesLibraryIdentity({ title: 'Tehanu', authorName: 'Ursula K. Le Guin' }, authorless)).toBe(false);
  });

  it('returns false for a genuinely new book', () => {
    expect(matchesLibraryIdentity({ title: 'Brand New Book', authorName: 'New Author' }, owned)).toBe(false);
  });
});
