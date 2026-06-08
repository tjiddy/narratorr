/**
 * Shared embedded disc-marker parser — consumed by discovery grouping
 * (`book-discovery.ts`), import-time group reconstruction, `extractDiscNumber`, and the
 * `copyAudioFiles` disc classification (`import-helpers.ts`). One regex, no forks.
 */

/**
 * Embedded disc-marker grammar — matches `(Disc|Disk|CD|D) <N> [of <M>]`, case-insensitive,
 * where <N>/<M> are 1–3 digit integers. Unlike a whole-name bare token or a parenthesized
 * titled-disc folder, this finds a marker *embedded* in a longer release string. The marker
 * may be trailing or followed only by further release metadata (e.g. ` - File ~ of 28 - yEnc`).
 */
const EMBEDDED_DISC_MARKER_RE = /\b(?:disc|disk|cd|d)\s*(\d{1,3})(?:\s+of\s+(\d{1,3}))?/i;

export interface EmbeddedDiscMarker {
  /**
   * The folder-name text BEFORE the disc marker, trailing separators/whitespace trimmed.
   * Empty for bare-token names ("CD1", "Disc 2") — callers grouping by stem must reject
   * empty stems so the bare-token DISC_FOLDER_PATTERN path stays authoritative for those.
   */
  stem: string;
  discNumber: number;
  /** The `of <M>` total when present — informational for grouping (consistency guard). */
  total?: number;
}

/**
 * Parse an embedded disc marker out of a longer release folder name.
 *
 * Returns null when no marker is present, or when a marker keyword carries no disc digit
 * (e.g. "… Disc of 10 …") — so malformed names never crash or get treated as disc members.
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

/** Normalize a common stem for case/whitespace-insensitive group identity. */
export function normalizeStem(stem: string): string {
  return stem.toLowerCase().replace(/\s+/g, ' ').trim();
}
