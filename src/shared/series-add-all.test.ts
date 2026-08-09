import { describe, it, expect } from 'vitest';
import { isAddAllSelectable, selectAddAllMembers, type AddAllSelectableMember } from './series-add-all.js';

function member(overrides: Partial<AddAllSelectableMember> = {}): AddAllSelectableMember {
  return { title: 'A Book', position: 1, inLibrary: false, ...overrides };
}

describe('isAddAllSelectable', () => {
  describe('position', () => {
    it.each([1, 2, 17, 1.0, 9007199254740991])('includes integer position %s', (position) => {
      expect(isAddAllSelectable(member({ position }))).toBe(true);
    });

    it.each([0.5, 1.5, 17.2, 0.1, 11.2])('excludes fractional position %s', (position) => {
      expect(isAddAllSelectable(member({ position }))).toBe(false);
    });

    it.each([0, -1, -2.5])('excludes non-positive position %s', (position) => {
      expect(isAddAllSelectable(member({ position }))).toBe(false);
    });

    it('excludes a null position', () => {
      expect(isAddAllSelectable(member({ position: null }))).toBe(false);
    });

    it.each([NaN, Infinity, -Infinity])('excludes the non-finite position %s', (position) => {
      expect(isAddAllSelectable(member({ position }))).toBe(false);
    });
  });

  describe('ownership', () => {
    it.each([1, 2, 0.5, 0, -1])('excludes an owned member at position %s', (position) => {
      expect(isAddAllSelectable(member({ position, inLibrary: true }))).toBe(false);
    });
  });

  describe('title', () => {
    it.each(['', '   ', '\t\n'])('excludes the blank title %j', (title) => {
      expect(isAddAllSelectable(member({ title }))).toBe(false);
    });

    it('includes a title padded around real text', () => {
      expect(isAddAllSelectable(member({ title: '  Real Title  ' }))).toBe(true);
    });
  });
});

describe('selectAddAllMembers', () => {
  it('keeps only the selectable members, in input order', () => {
    const members = [
      member({ title: 'One', position: 1 }),
      member({ title: 'Novella', position: 1.5 }),
      member({ title: 'Two', position: 2 }),
      member({ title: 'Owned', position: 3, inLibrary: true }),
      member({ title: '  ', position: 4 }),
      member({ title: 'Unpositioned', position: null }),
      member({ title: 'Prequel', position: 0 }),
    ];

    expect(selectAddAllMembers(members).map((m) => m.title)).toEqual(['One', 'Two']);
  });

  it('returns an empty array when nothing qualifies', () => {
    expect(selectAddAllMembers([member({ position: null }), member({ inLibrary: true })])).toEqual([]);
  });

  it('preserves the caller element type so extra fields survive the filter', () => {
    const enriched = [{ ...member({ title: 'One' }), libraryBookId: 7 }];
    expect(selectAddAllMembers(enriched)[0]?.libraryBookId).toBe(7);
  });
});
