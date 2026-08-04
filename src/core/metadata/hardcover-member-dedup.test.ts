import { describe, it, expect } from 'vitest';
import {
  isScriptCleanTitle,
  normalizeMemberPosition,
  normalizeReadershipCount,
  pickPreferredMembersByPosition,
  type HardcoverMemberRow,
} from './hardcover-member-dedup.js';

/**
 * #2097 — Hardcover carries duplicate WORK entries for the same book at the
 * same series position (a translation registered as its own work rather than an
 * edition). The queries used to collapse those rows with `distinct_on: position`
 * ordered by readership, which handed the slot to the MOST-READ work regardless
 * of script; this picker replaces that with an explicit library-language
 * preference. Every assertion below keys on `book.id` where a title could
 * coincide, so no test can pass by title accident.
 */
describe('hardcover-member-dedup', () => {
  function row(position: number | null | undefined, id: number, title: string, usersCount?: number | null): HardcoverMemberRow {
    return { position, book: { id, title, users_count: usersCount } };
  }

  function ids(rows: readonly HardcoverMemberRow[]): number[] {
    return rows.map((r) => r.book.id);
  }

  describe('isScriptCleanTitle', () => {
    it('classifies a Latin-only title as script-clean', () => {
      expect(isScriptCleanTitle('Before the Storm')).toBe(true);
    });

    /**
     * AC5 — the counterfactual the whole issue turns on. The live WoW title
     * carries 15 Latin letters against 10 Cyrillic, so ANY Latin-majority ratio
     * rule scores it as Latin and preserves the exact defect this fix exists to
     * remove. The rule is "contains any non-Latin letter", not "is mostly Latin".
     */
    it('classifies the live WoW Cyrillic title as NOT script-clean despite a Latin majority (AC5)', () => {
      const title = 'World of Warcraft: Перед бурей';
      const latin = [...title].filter((c) => /\p{Script=Latin}/u.test(c)).length;
      const nonLatin = [...title].filter((c) => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c)).length;
      // Guard the guard: if this ratio ever stops holding the test below is no
      // longer the counterfactual it claims to be.
      expect(latin).toBeGreaterThan(nonLatin);
      expect(isScriptCleanTitle(title)).toBe(false);
    });

    /**
     * AC6 — letters only, no decomposition, no combining-mark strip, no reuse of
     * `normalizeTitleForVariantMatch` / `normalizeTitleLosslessly`. An accented
     * Latin title is script-clean and is never passed over for an unaccented
     * sibling.
     */
    it.each(['Café Society', 'Über Alles', 'Sạch', 'Æther Ørn Straße'])('treats the diacritic/ligature Latin title %j as script-clean (AC6)', (title) => {
      expect(isScriptCleanTitle(title)).toBe(true);
    });

    it('treats a zero-letter title as script-clean vacuously (AC4)', () => {
      expect(isScriptCleanTitle('1984')).toBe(true);
      expect(isScriptCleanTitle('— 7 (#3) …')).toBe(true);
      expect(isScriptCleanTitle('')).toBe(true);
    });

    it.each(['Перед бурей', '嵐の前に', 'ספר', 'كِتاب', 'Ω Δoc'])('flags %j as not script-clean', (title) => {
      expect(isScriptCleanTitle(title)).toBe(false);
    });

    it('flags a single non-Latin letter buried in an otherwise Latin title', () => {
      expect(isScriptCleanTitle('Before the Storм')).toBe(false);
    });
  });

  describe('normalizeMemberPosition', () => {
    it('passes a finite number through unchanged', () => {
      expect(normalizeMemberPosition(15)).toBe(15);
      expect(normalizeMemberPosition(2.5)).toBe(2.5);
      expect(normalizeMemberPosition(0)).toBe(0);
      expect(normalizeMemberPosition(-3)).toBe(-3);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a numeric string', '15'],
    ])('maps %s to null (AC3, F3)', (_label, value) => {
      expect(normalizeMemberPosition(value)).toBeNull();
    });
  });

  describe('normalizeReadershipCount', () => {
    /**
     * AC4 + F2 — `0` is a legitimate readership and must NOT be coerced to a
     * fallback; `null` must NOT produce `NaN`. This helper is asserted directly
     * because at the picker level `?? 0` and `|| 0` are observationally
     * identical, so the picker alone cannot prove the operator choice.
     */
    it('keeps a legitimate zero as zero (AC4 falsy-coercion guard)', () => {
      expect(normalizeReadershipCount(0)).toBe(0);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a string', '62'],
    ])('normalizes %s to 0 without producing NaN (AC4, F3)', (_label, value) => {
      const normalized = normalizeReadershipCount(value);
      expect(normalized).toBe(0);
      expect(Number.isNaN(normalized)).toBe(false);
    });

    it('passes finite counts through, including negatives', () => {
      expect(normalizeReadershipCount(62)).toBe(62);
      expect(normalizeReadershipCount(-4)).toBe(-4);
    });
  });

  describe('pickPreferredMembersByPosition — script preference', () => {
    it('keeps the English work over the Cyrillic one at the same position (AC4)', () => {
      const rows = [row(15, 465829, 'World of Warcraft: Перед бурей', 62), row(15, 331, 'Before the Storm', 7)];
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([331]);
    });

    /**
     * AC14 — the live prod case (2026-08-03), verbatim. The Russian work wins on
     * readership 62-to-7 and still loses: that inversion IS the fix. A picker
     * that only sorted by `users_count` passes every other test in this file.
     */
    it('picks the English work despite it LOSING on readership (AC14, live WoW #15)', () => {
      const russian = row(15, 465829, 'World of Warcraft: Перед бурей', 62);
      const english = row(15, 331, 'Before the Storm', 7);
      const picked = pickPreferredMembersByPosition([russian, english]);
      expect(picked).toHaveLength(1);
      expect(picked[0]).toBe(english);
      expect(picked[0]!.book.id).toBe(331);
    });

    it('applies the preference regardless of input order', () => {
      const russian = row(15, 465829, 'World of Warcraft: Перед бурей', 62);
      const english = row(15, 331, 'Before the Storm', 7);
      expect(ids(pickPreferredMembersByPosition([english, russian]))).toEqual([331]);
      expect(ids(pickPreferredMembersByPosition([russian, english]))).toEqual([331]);
    });

    it('restricts to the script-clean rows before the readership sort (three-row group)', () => {
      const rows = [
        row(4, 900, 'Перед бурей', 900),
        row(4, 901, 'Before the Storm', 5),
        row(4, 902, 'Before the Storm (Anniversary)', 9),
      ];
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([902]);
    });

    /**
     * AC4 — a position is NEVER dropped entirely. With no script-clean row the
     * whole group survives the partition and readership decides.
     */
    it('keeps the position when NO row is script-clean, picking by readership (AC4)', () => {
      const rows = [row(2, 700, '嵐の前に', 3), row(2, 701, '沈黙の螺旋', 40)];
      const picked = pickPreferredMembersByPosition(rows);
      expect(picked).toHaveLength(1);
      expect(picked[0]!.book.id).toBe(701);
    });

    /**
     * AC7 — a singleton group is returned untouched and the predicate is never
     * applied to it, so a series whose sole work at a position is Russian /
     * Japanese / Hebrew keeps that work and the member does not vanish.
     */
    it.each(['Перед бурей', '嵐の前に', 'ספר'])('returns a lone non-Latin row at a position untouched: %j (AC7)', (title) => {
      const only = row(9, 555, title, 1);
      const picked = pickPreferredMembersByPosition([only]);
      expect(picked).toEqual([only]);
      expect(picked[0]).toBe(only);
    });

    /**
     * AC6 — the accent must not decide the pick. Both titles are script-clean,
     * so readership does, and the accented title wins here precisely because it
     * has the higher count.
     */
    it('lets readership decide between an accented and an unaccented Latin title (AC6)', () => {
      expect(ids(pickPreferredMembersByPosition([
        row(3, 810, 'Cafe Society', 4),
        row(3, 811, 'Café Society', 9),
      ]))).toEqual([811]);
      expect(ids(pickPreferredMembersByPosition([
        row(3, 812, 'Café Society', 4),
        row(3, 813, 'Cafe Society', 9),
      ]))).toEqual([813]);
    });
  });

  describe('pickPreferredMembersByPosition — tie-breaks', () => {
    it('prefers the higher users_count when both rows are script-clean (AC4)', () => {
      expect(ids(pickPreferredMembersByPosition([
        row(1, 10, 'Book One', 5),
        row(1, 11, 'Book One (Reissue)', 50),
      ]))).toEqual([11]);
    });

    it('breaks an equal users_count tie on the lower book.id (AC4)', () => {
      expect(ids(pickPreferredMembersByPosition([
        row(1, 22, 'Book One (Reissue)', 50),
        row(1, 21, 'Book One', 50),
      ]))).toEqual([21]);
      expect(ids(pickPreferredMembersByPosition([
        row(1, 21, 'Book One', 50),
        row(1, 22, 'Book One (Reissue)', 50),
      ]))).toEqual([21]);
    });

    /**
     * AC4 + F2 — `0` and `null` normalize to the SAME score, so the id tie-break
     * decides, and it must decide identically in both input orders. Asserting
     * "the 0 row wins" instead would be either order-dependent or a restatement
     * of the id rule.
     */
    it('ties users_count 0 against null and settles on the lower book.id, in both input orders (AC4, F2)', () => {
      const zeroLowId = row(6, 30, 'Zero Readers', 0);
      const nullHighId = row(6, 31, 'Null Readers', null);
      expect(pickPreferredMembersByPosition([zeroLowId, nullHighId])[0]!.book.id).toBe(30);
      expect(pickPreferredMembersByPosition([nullHighId, zeroLowId])[0]!.book.id).toBe(30);

      const nullLowId = row(7, 40, 'Null Readers', null);
      const zeroHighId = row(7, 41, 'Zero Readers', 0);
      expect(pickPreferredMembersByPosition([nullLowId, zeroHighId])[0]!.book.id).toBe(40);
      expect(pickPreferredMembersByPosition([zeroHighId, nullLowId])[0]!.book.id).toBe(40);
    });

    /**
     * F2's mutation-resistant half: a nonzero fallback for the `0` row (e.g.
     * `count || 10`) would flip this result, and the id tie-break cannot mask it
     * because the zero row also holds the LOWER id.
     */
    it('lets a real readership beat a zero even when the zero row has the lower id (AC4, F2)', () => {
      expect(ids(pickPreferredMembersByPosition([
        row(8, 50, 'Zero Readers', 0),
        row(8, 51, 'Three Readers', 3),
      ]))).toEqual([51]);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('treats a %s users_count as 0 so a finite count wins (AC4, F3)', (_label, value) => {
      expect(ids(pickPreferredMembersByPosition([
        row(2, 60, 'Non-Finite Readers', value),
        row(2, 61, 'One Reader', 1),
      ]))).toEqual([61]);
    });
  });

  describe('pickPreferredMembersByPosition — unpositioned rows', () => {
    /**
     * AC3 — `DISTINCT ON` treats SQL NULLs as equal, so today every unpositioned
     * work in a series collapses to one row. After this change each one surfaces:
     * a member-count increase on such series, and the correct behavior — those
     * are different books, not duplicates.
     */
    it('passes null / missing / NaN positions through without dedup (AC3)', () => {
      const rows = [
        row(null, 70, 'Companion A', 5),
        { book: { id: 71, title: 'Companion B', users_count: 5 } } satisfies HardcoverMemberRow,
        row(Number.NaN, 72, 'Companion C', 5),
      ];
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([70, 71, 72]);
    });

    it.each([
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('passes %s positions through as unpositioned rather than grouping them (AC3, F3)', (_label, value) => {
      const rows = [row(value, 80, 'Odd A', 5), row(value, 81, 'Odd B', 500)];
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([80, 81]);
    });

    it('never lets an unpositioned row displace a positioned one', () => {
      const rows = [row(null, 90, 'Перед бурей', 900), row(1, 91, 'Book One', 1)];
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([90, 91]);
    });
  });

  describe('pickPreferredMembersByPosition — ordering and non-regression', () => {
    /**
     * AC9 — the picker must be a pure filter over the source array. Member order
     * is load-bearing for `persistMembers`, which walks members in adapter order
     * and claims library books greedily through a shared `matchedLibraryIds` set
     * (the #2108 pinned claim order). (The cache render path re-sorts by
     * position then title, so it does not observe this ordering — F1.)
     */
    it('returns distinct-position input identically: same rows, same order, same identity (AC9)', () => {
      const rows = [
        row(1, 100, 'Kings of the Wyld', 100),
        row(2, 101, 'Bloody Rose', 80),
        row(3, 102, 'Outlaw Empire', 60),
      ];
      const picked = pickPreferredMembersByPosition(rows);
      expect(picked).toEqual(rows);
      expect(picked).toHaveLength(rows.length);
      picked.forEach((r, i) => expect(r).toBe(rows[i]));
    });

    it('does not mutate the input array (AC9)', () => {
      const rows = [row(1, 110, 'B', 1), row(1, 111, 'A', 9), row(2, 112, 'C', 1)];
      const snapshot = [...rows];
      pickPreferredMembersByPosition(rows);
      expect(rows).toEqual(snapshot);
      rows.forEach((r, i) => expect(r).toBe(snapshot[i]));
    });

    it('preserves first-seen source order across interleaved positions (AC9)', () => {
      const rows = [
        row(1, 120, 'One Alpha', 5),
        row(2, 121, 'Two', 5),
        row(1, 122, 'One Beta', 50),
        row(3, 123, 'Three', 5),
      ];
      // Position 1 resolves to the higher-readership row (122), which sat third
      // in the source; the retained rows still come back in source order.
      expect(ids(pickPreferredMembersByPosition(rows))).toEqual([121, 122, 123]);
    });

    it('returns an empty array for empty input', () => {
      expect(pickPreferredMembersByPosition([])).toEqual([]);
    });

    it('preserves extra row fields on the retained rows (generic pass-through)', () => {
      const rows = [
        { position: 1, book: { id: 130, title: 'Перед бурей', users_count: 900, slug: 'ru' } },
        { position: 1, book: { id: 131, title: 'Before the Storm', users_count: 2, slug: 'en' } },
      ];
      const picked = pickPreferredMembersByPosition(rows);
      expect(picked).toHaveLength(1);
      expect(picked[0]!.book.slug).toBe('en');
    });
  });
});
