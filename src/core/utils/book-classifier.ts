import { basename, extname } from 'node:path';
import { BYTES_PER_MB } from '../../shared/constants.js';

/**
 * Merge-biased classifier for leaf folders containing 2+ loose audio files.
 *
 * Decides whether a leaf folder represents ONE chapter-encoded book (merge —
 * default) or N standalone books loose-packed in a single folder (split). The
 * bias is asymmetric: false-merges produce 1 import row to fix; false-splits
 * produce N rows. Default to merge; split only when ALL split conditions hold.
 *
 * See issue #1016 for the full decision-rule rationale.
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
 * Anchored on start-or-separator BEFORE the marker; allow optional separator
 * + digits AFTER. A post-marker `\b` would FAIL on "Disc01" because both `c`
 * and `0` are word chars; the pre-marker boundary + required digits is the
 * correct shape.
 *
 * Excluded: book|volume|vol — too ambiguous (real titles like "Mistborn Book 1").
 */
const MERGE_MARKER_RE = /(?:^|[\s_\-.])(chapter|chap|track|trk|disc|disk|cd|part|pt)[\s_\-.]*\d+/i;
const MERGE_MARKER_GLOBAL_RE = /(?:^|[\s_\-.])(chapter|chap|track|trk|disc|disk|cd|part|pt)[\s_\-.]*\d+/gi;
const NUMERIC_ONLY_RE = /^\d+$/;
const ALPHA_COUNT_RE = /[A-Za-z]/g;

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

  // Marker rule (#1048): require ALL stems to match MERGE_MARKER_RE AND share a
  // markerless prefix. The pre-#1048 `.some()` rule false-fired on a single stray
  // "Part 1" in a batch of distinct titles, which mattered catastrophically when
  // the same classifier drove mixed-content absorption.
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

  // Three-condition layered evidence (issue #1035): a single ratio cutoff
  // mis-merges series collections like Reacher (21 novels + 7 novellas →
  // 0.75 ratio) where many obviously-complete books outweigh a handful of
  // shorts. OR-combine a clean-pack ratio, a mixed-plurality count+ratio,
  // and a big-collection floor. Source order encodes precedence for the
  // matrix in the spec but is not surfaced — `sizeEvidence` reports the
  // raw counts so callers can log without recomputation.
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
 * Strip the rightmost MERGE_MARKER_RE occurrence from each stem and compare the
 * leading prefixes. Empty markerless prefix (e.g., bare `Chapter NN` stems where
 * the entire stem IS the marker) collapses to `""` — treated as "shared" so a
 * folder of pure chapter stems still merges.
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
 * Strict-evidence predicate (#1048) for the mixed-content branch in
 * book-discovery. Returns true ONLY when the loose top-level audio set is
 * UNAMBIGUOUSLY a chapter-encoded book — never on count caps, size heuristics,
 * or subset-duplicate signals that are safe at leaf scope but catastrophic
 * when they drive recursive subtree absorption.
 *
 * Differs from `classifyLeafFolder` in three ways: (1) skips the count cap and
 * size guards entirely; (2) requires `distinct === 1` for the all-same-stem
 * rule (vs. classifier's `distinct < count`, which fires on any subset
 * duplicate); (3) consults no merge-biased default reasons.
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

  return false;
}
