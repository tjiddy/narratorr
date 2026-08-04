/**
 * Per-position duplicate picker for Hardcover series members (#2097).
 *
 * Hardcover registers some translations as their own WORK rather than as an
 * edition of the original, so a series can carry two or more works at the same
 * position. The members queries used to collapse those with
 * `distinct_on: position` ordered by `users_count desc`, which handed the slot
 * to the MOST-READ work regardless of script — live case, prod 2026-08-03: the
 * Russian "World of Warcraft: Перед бурей" (62 readers) beat the English
 * "Before the Storm" (7) at position 15 of the WoW series, so the card and the
 * cached member row both showed the Cyrillic title.
 *
 * This module replaces that with an explicit library-language preference. It is
 * pure and consumes RAW parsed rows, not `HardcoverMember`s: the decision needs
 * `book.users_count` and `book.id`, neither of which is part of the mapped
 * member shape (AC10).
 *
 * "Library language" is approximated by "Latin script", deliberately and with no
 * setting behind it (AC5 non-goal) — this is a narrow pick-the-right-duplicate
 * heuristic, and the durable fix for the data itself is a Hardcover librarian
 * merge upstream.
 */

/**
 * The structural slice of a parsed `book_series` row the picker reads. Declared
 * here rather than imported from `hardcover.ts` so the dependency runs one way
 * (adapter → picker) and the picker stays trivially testable.
 */
export interface HardcoverMemberRow {
  position?: number | null | undefined;
  book: {
    id: number;
    title: string;
    users_count?: number | null | undefined;
  };
}

/**
 * The grouping key, shared with `mapMember` in `hardcover.ts` so the notion of
 * "same position" cannot drift between the two. A divergence here would
 * silently change WHICH rows count as duplicates.
 *
 * Anything that is not a finite number — `null`, missing, `NaN`, `±Infinity`,
 * a numeric string — is unpositioned.
 */
export function normalizeMemberPosition(position: unknown): number | null {
  return typeof position === 'number' && Number.isFinite(position) ? position : null;
}

/**
 * Readership, normalized for comparison. `0` is a LEGITIMATE value (a work
 * nobody has logged) and must survive as `0` rather than collapsing to a
 * fallback, and a `null`/absent count — `users_count` is `.nullish()` per the
 * external-API schema rule — must not produce `NaN` and poison every comparison
 * it touches.
 */
export function normalizeReadershipCount(count: unknown): number {
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

const ANY_LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * True when the title contains no letter outside the Latin script. A title with
 * zero letters (digits and punctuation only, e.g. `"1984"`) is script-clean
 * vacuously.
 *
 * Two properties this deliberately does NOT have:
 *
 *  - **It is not a Latin-MAJORITY ratio.** `"World of Warcraft: Перед бурей"`
 *    carries 15 Latin letters against 10 Cyrillic, so a `>50%` rule scores the
 *    Russian work as Latin and preserves the exact defect this module exists to
 *    fix (AC5). The question is "any non-Latin letter?", not "mostly Latin?".
 *  - **It examines LETTERS ONLY.** No NFD decomposition, no combining-mark
 *    strip, and no call into `normalizeTitleForVariantMatch` /
 *    `normalizeTitleLosslessly` — those two folds are held in lockstep so
 *    `hasDegenerateFullForm` can tell what the scalar fold discarded, and a
 *    third consumer with a different band would be a silent divergence in that
 *    contract. It also means a diacritic-bearing Latin title ("Café", "Über")
 *    stays script-clean and is never passed over for an unaccented sibling
 *    (AC6).
 *
 * Iteration is by code point (`for…of` on a string), so astral letters are
 * classified as single characters rather than surrogate halves.
 */
export function isScriptCleanTitle(title: string): boolean {
  for (const char of title) {
    if (ANY_LETTER.test(char) && !LATIN_LETTER.test(char)) return false;
  }
  return true;
}

function preferredInGroup<T extends HardcoverMemberRow>(rows: readonly T[]): T {
  // Tier 1: restrict to the script-clean rows when there are any. When there
  // are none the whole group is kept — a position is NEVER dropped entirely,
  // so a slot whose every work is Russian/Japanese/Hebrew still yields a member.
  const scriptClean = rows.filter((row) => isScriptCleanTitle(row.book.title));
  const pool = scriptClean.length > 0 ? scriptClean : rows;
  return pool.reduce((best, candidate) => {
    const bestCount = normalizeReadershipCount(best.book.users_count);
    const candidateCount = normalizeReadershipCount(candidate.book.users_count);
    if (candidateCount !== bestCount) return candidateCount > bestCount ? candidate : best;
    return candidate.book.id < best.book.id ? candidate : best;
  });
}

/**
 * Returns at most one row per finite numeric position, preserving the relative
 * order of the rows it retains (AC9 — `persistMembers` walks members in this
 * order and claims library books greedily through a shared `matchedLibraryIds`
 * set, so a reordering picker would change which book claims which member).
 *
 * Rows without a finite position are EXEMPT from dedup and always pass through.
 * `DISTINCT ON` treats SQL NULLs as equal, so today all unpositioned works in a
 * series collapse into one row; after this change every one of them surfaces.
 * That is a member-count increase on such series and is the correct behavior —
 * those are different books, not duplicates (AC3).
 *
 * A group of exactly one row is returned untouched: the script predicate is
 * never applied to a singleton (AC7).
 */
export function pickPreferredMembersByPosition<T extends HardcoverMemberRow>(rows: readonly T[]): T[] {
  const groups = new Map<number, number[]>();
  rows.forEach((row, index) => {
    const position = normalizeMemberPosition(row.position);
    if (position === null) return;
    const group = groups.get(position);
    if (group) group.push(index);
    else groups.set(position, [index]);
  });

  const retained = new Set<number>();
  for (const indices of groups.values()) {
    if (indices.length === 1) {
      retained.add(indices[0]!);
      continue;
    }
    const winner = preferredInGroup(indices.map((index) => rows[index]!));
    retained.add(indices.find((index) => rows[index] === winner)!);
  }

  return rows.filter((row, index) => normalizeMemberPosition(row.position) === null || retained.has(index));
}
