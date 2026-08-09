/**
 * Hardcover can register translations as separate works at one series position.
 * Prefer Latin-script titles before readership; raw rows supply the count and stable id tie-break.
 */

export interface HardcoverMemberRow {
  position?: number | null | undefined;
  book: {
    id: number;
    title: string;
    users_count?: number | null | undefined;
  };
}

/** Shared grouping key: only finite numeric positions can be duplicates. */
export function normalizeMemberPosition(position: unknown): number | null {
  return typeof position === 'number' && Number.isFinite(position) ? position : null;
}

export function normalizeReadershipCount(count: unknown): number {
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

const ANY_LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * Rejects any non-Latin letter, not merely a non-Latin majority. Digits, punctuation,
 * combining marks, and zero-letter titles do not affect the result; `for…of` preserves code points.
 */
export function isScriptCleanTitle(title: string): boolean {
  for (const char of title) {
    if (ANY_LETTER.test(char) && !LATIN_LETTER.test(char)) return false;
  }
  return true;
}

function preferredInGroup<T extends HardcoverMemberRow>(rows: readonly T[]): T {
  // If no script-clean row exists, keep the whole group eligible so the position survives.
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
 * Keeps at most one row per finite position while preserving retained source order;
 * persistence claims library books greedily in that order. Unpositioned rows always pass through.
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
