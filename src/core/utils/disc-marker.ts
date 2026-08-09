/**
 * Shared disc-marker grammar for discovery, import reconstruction, number extraction, and copying.
 * These paths must not fork their regexes.
 */

/**
 * Matches embedded `Disc|Disk|CD <N> [of <M>]`, with 1–3 digit numbers. Deliberately excludes
 * `D<n>` because `Star Wars D2 Adventures` is indistinguishable from a marker and could falsely
 * coalesce siblings. Whole-name `D1` and parenthesized `(D 1)` remain handled elsewhere.
 */
const EMBEDDED_DISC_MARKER_RE = /\b(?:disc|disk|cd)\s*(\d{1,3})(?:\s+of\s+(\d{1,3}))?/i;

export interface EmbeddedDiscMarker {
  /**
   * Text before the marker, with trailing separators removed. Grouping callers must reject an
   * empty stem so bare-token folders remain owned by `DISC_FOLDER_PATTERN`.
   */
  stem: string;
  discNumber: number;
  /** Optional `of <M>` total used only by the consistency guard. */
  total?: number;
}

/**
 * Returns null for missing or malformed markers; `Disc of 10` is never treated as a member.
 */
export function parseEmbeddedDiscMarker(name: string): EmbeddedDiscMarker | null {
  if (!name) return null;
  const match = name.match(EMBEDDED_DISC_MARKER_RE);
  if (!match || match.index === undefined) return null;
  const stem = name.slice(0, match.index).replace(/[\s\-_–]+$/, '').trim();
  const result: EmbeddedDiscMarker = { stem, discNumber: parseInt(match[1]!, 10) };
  if (match[2] !== undefined) result.total = parseInt(match[2], 10);
  return result;
}

export function normalizeStem(stem: string): string {
  return stem.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when `name`'s normalized form begins with `stemKey` at a separator/word boundary. */
export function sharesStemPrefix(name: string, stemKey: string): boolean {
  const n = normalizeStem(name);
  if (n === stemKey) return true;
  if (!n.startsWith(stemKey)) return false;
  const next = n.charAt(stemKey.length);
  return next === ' ' || next === '-' || next === '_' || next === ':' || next === ',';
}

/**
 * Replays discovery's two coalescing guards: explicit totals must agree and every stem-sharing
 * sibling must carry a marker. Import reconstruction must reject the same ambiguous groups.
 */
export function discGroupGuardsPass(siblingNames: string[], stemKey: string): boolean {
  const memberMarkers = siblingNames
    .map(name => parseEmbeddedDiscMarker(name))
    .filter((m): m is EmbeddedDiscMarker => m !== null && m.stem !== '' && normalizeStem(m.stem) === stemKey);

  const totals = new Set(memberMarkers.map(m => m.total).filter((t): t is number => t !== undefined));
  if (totals.size > 1) return false;

  return siblingNames
    .filter(name => sharesStemPrefix(name, stemKey))
    .every(name => {
      const m = parseEmbeddedDiscMarker(name);
      return m !== null && m.stem !== '';
    });
}
