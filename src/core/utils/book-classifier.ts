import { basename, extname } from 'node:path';
import { BYTES_PER_MB } from '@shared/constants.js';

/**
 * Merge-biased leaf-folder classifier: one chapter-encoded book versus multiple loose-packed books.
 * A false merge creates one row to fix; a false split creates many, so splitting requires every
 * split condition to hold.
 */

const COMPLETE_BOOK_MIN_SIZE = 120 * BYTES_PER_MB;
const SPLIT_MIN_FILE_COUNT = 2;
const SPLIT_MAX_FILE_COUNT = 30;
const LARGE_FILE_RATIO = 0.8;
const LARGE_COUNT_FOR_PLURALITY = 3;
const RATIO_FOR_PLURALITY = 0.5;
const LARGE_COUNT_FLOOR = 10;
const NUMERIC_ONLY_MIN_COUNT = 2;
const MIN_TITLE_CHARS = 3;

/**
 * Marker needs a start/separator boundary before the keyword; a post-keyword word boundary would
 * reject `Disc01`. `book|volume|vol` are excluded as title-ambiguous. Roman parts accept only
 * standalone canonical I–XXXIX, avoiding words such as `Mix` and `Civil`. Its trailing boundary
 * stays inside the Roman alternative so Arabic `Part 12abc` continues matching `12`.
 */
const MERGE_MARKER_RE = /(?:^|[\s_\-.])(chapter|chap|track|trk|disc|disk|cd|part|pt)[\s_\-.]*(?:\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})(?=[\s_\-.]|$))/i;
const MERGE_MARKER_GLOBAL_RE = /(?:^|[\s_\-.])(chapter|chap|track|trk|disc|disk|cd|part|pt)[\s_\-.]*(?:\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})(?=[\s_\-.]|$))/gi;
const NUMERIC_ONLY_RE = /^\d+$/;
const ALPHA_COUNT_RE = /[A-Za-z]/g;
/**
 * Mandatory separator after a numeric prefix keeps titles such as `1Q84` and `01Heir` intact.
 */
const NUMERIC_PREFIX_RE = /^\d+[-_.\s]+/;

export interface ClassifierFile {
  path: string;
  size: number;
}

export interface ClassifierResult {
  decision: 'merge' | 'split';
  reason: string;
  sizeEvidence?: { largeCount: number; largeRatio: number };
}

export function classifyLeafFolder(files: ClassifierFile[]): ClassifierResult {
  const count = files.length;
  if (count < SPLIT_MIN_FILE_COUNT) return { decision: 'merge', reason: 'single-file' };
  if (count > SPLIT_MAX_FILE_COUNT) return { decision: 'merge', reason: 'count-exceeds-cap' };

  const stems = files.map(f => basename(f.path, extname(f.path)));

  // Every stem must carry a marker and share its markerless prefix; one stray `Part 1` proves nothing.
  const markerStems = stems.filter(s => MERGE_MARKER_RE.test(s));
  if (
    markerStems.length >= 2
    && markerStems.length === stems.length
    && sameMarkerlessPrefix(markerStems)
  ) {
    return { decision: 'merge', reason: 'chapter-disc-part-marker' };
  }
  if (count >= NUMERIC_ONLY_MIN_COUNT && stems.every(s => NUMERIC_ONLY_RE.test(s))) {
    return { decision: 'merge', reason: 'numeric-only-stems' };
  }

  const normalized = stems.map(normalizeStemForComparison);
  const distinct = new Set(normalized.map(s => s.toLowerCase().trim())).size;
  if (distinct < count) {
    return { decision: 'merge', reason: 'duplicate-normalized-stems' };
  }

  const allHaveTitleContent = normalized.every(
    s => (s.match(ALPHA_COUNT_RE)?.length ?? 0) >= MIN_TITLE_CHARS,
  );
  if (!allHaveTitleContent) {
    return { decision: 'merge', reason: 'normalized-stem-lacks-title-content' };
  }

  const largeCount = files.filter(f => f.size >= COMPLETE_BOOK_MIN_SIZE).length;
  const largeRatio = count > 0 ? largeCount / count : 0;

  // Layer ratio, plurality, and absolute-count evidence: Reacher's 21 novels plus 7 novellas has
  // only a 0.75 ratio but is still clearly a collection. Report raw counts for caller diagnostics.
  const sizeEvidenceForSplit =
    largeRatio >= LARGE_FILE_RATIO
    || (largeCount >= LARGE_COUNT_FOR_PLURALITY && largeRatio >= RATIO_FOR_PLURALITY)
    || largeCount >= LARGE_COUNT_FLOOR;

  if (!sizeEvidenceForSplit) {
    return { decision: 'merge', reason: 'files-too-small-for-full-books' };
  }

  return {
    decision: 'split',
    reason: 'distinct-large-files-no-marker',
    sizeEvidence: { largeCount, largeRatio },
  };
}

function normalizeStemForComparison(stem: string): string {
  return stem
    .replace(/^\d+\s*[-_.]\s*/, '')
    .replace(/^[A-Za-z][\w\s]*?\s+\d+\s*[-_.]\s*/, '')
    .replace(/\s+\d+\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/**
 * Compares prefixes before the rightmost marker. Bare `Chapter NN` stems share an empty prefix and
 * therefore still merge.
 */
function sameMarkerlessPrefix(stems: string[]): boolean {
  const prefixes = new Set<string>();
  for (const stem of stems) {
    const matches = [...stem.matchAll(MERGE_MARKER_GLOBAL_RE)];
    const last = matches[matches.length - 1];
    const stripped = last ? stem.substring(0, last.index) : stem;
    const normalized = stripped.replace(/[\s\W_]+/g, ' ').trim().toLowerCase();
    prefixes.add(normalized);
  }
  return prefixes.size === 1;
}

/**
 * Strict mixed-content evidence for recursive absorption. Unlike the merge-biased leaf classifier,
 * it ignores count/size guards and subset duplicates; every normalized stem must be identical or a
 * positive marker/prefix rule must fire.
 */
export function hasStrongChapterSetEvidence(files: ClassifierFile[]): boolean {
  if (files.length < 2) return false;
  const stems = files.map(f => basename(f.path, extname(f.path)));

  if (stems.every(s => MERGE_MARKER_RE.test(s)) && sameMarkerlessPrefix(stems)) {
    return true;
  }

  if (stems.every(s => NUMERIC_ONLY_RE.test(s))) return true;

  const lowered = stems.map(s => normalizeStemForComparison(s).toLowerCase().trim());
  const distinct = new Set(lowered).size;
  if (distinct === 1 && lowered[0]!.length > 0) return true;

  // Real torrents use `01 Heir...`; require a separator so digit-prefixed titles remain distinct.
  if (stems.every(s => NUMERIC_PREFIX_RE.test(s))) {
    const titlePortions = stems.map(
      s => s.replace(NUMERIC_PREFIX_RE, '').toLowerCase().trim(),
    );
    const distinctTitles = new Set(titlePortions).size;
    if (distinctTitles === 1 && titlePortions[0]!.length > 0) {
      return true;
    }
  }

  return false;
}
