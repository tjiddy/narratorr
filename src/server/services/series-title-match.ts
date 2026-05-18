/** Floating-point tolerance for matching series_position values across sources. */
export const POSITION_MATCH_EPSILON = 1e-9;

/**
 * Normalize a member work title for "In Library" matching across Hardcover and
 * Audible naming variants. Strips subtitles after `:`, removes parenthetical
 * / bracketed annotations, peels common audio-edition tails
 * (`(Unabridged)`, `(Audio)`, `(Audible)`), folds curly apostrophes, lowercases,
 * collapses non-alphanumeric runs to single spaces.
 *
 * This is the matcher form — different from `normalizeSeriesName` because we
 * want title equivalence across noisy edition variants, not just a stable
 * DB-row key.
 */
export function normalizeMemberTitleForMatch(title: string): string {
  let stripped = title
    .replace(/[’‘]/g, "'")
    .replace(/\(\s*(?:unabridged|audio|audible)\s*\)/gi, ' ')
    .replace(/\[\s*(?:unabridged|audio|audible)\s*\]/gi, ' ');
  const colonIdx = stripped.indexOf(':');
  if (colonIdx >= 0) stripped = stripped.slice(0, colonIdx);
  stripped = stripped.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  return stripped.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface LibraryBookSummary {
  id: number;
  title: string;
  seriesPosition: number | null;
}

export interface HardcoverMemberSummary {
  title: string;
  position: number | null;
}

/**
 * Find the matching library book for a Hardcover member, using either
 * position equality (with ε tolerance) OR normalized-title equality. Both
 * signals are necessary: position-only fails when Audnexus / Hardcover
 * disagree on numbering (Dark Tower's Wind Through the Keyhole at 8 vs 4.5,
 * Hunger Games prequels at NULL vs 0/0.5). Title-only fails on edition
 * variants where titles drift but positions agree. Either-hits is the
 * empirical sweet spot. Library books MUST already be scoped to the current
 * series_name by the caller — this matcher does no scoping itself.
 *
 * `alreadyMatched` (optional) lets callers iterate a member list with
 * first-match-wins semantics: pass a Set of already-claimed library book ids
 * and add each returned candidate's id to it before the next call. Two
 * Hardcover members at the same position (or with normalized-equal titles)
 * can otherwise both claim the same library book, producing a duplicate
 * "In Library" badge and — in the persist path — a duplicate `bookId` in
 * `series_members`.
 */
export function findInLibraryMatch(
  member: HardcoverMemberSummary,
  candidates: LibraryBookSummary[],
  alreadyMatched?: ReadonlySet<number>,
): LibraryBookSummary | null {
  const memberNormalized = normalizeMemberTitleForMatch(member.title);
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    if (positionsMatch(member.position, candidate.seriesPosition)) return candidate;
  }
  if (memberNormalized.length === 0) return null;
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    if (normalizeMemberTitleForMatch(candidate.title) === memberNormalized) return candidate;
  }
  return null;
}

function positionsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < POSITION_MATCH_EPSILON;
}
