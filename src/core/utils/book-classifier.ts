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
const NUMERIC_ONLY_RE = /^\d+$/;
const ALPHA_COUNT_RE = /[A-Za-z]/g;

export interface ClassifierFile {
  path: string;
  size: number;
}

export interface ClassifierResult {
  decision: 'merge' | 'split';
  reason: string;
}

export function classifyLeafFolder(files: ClassifierFile[]): ClassifierResult {
  const count = files.length;
  if (count < SPLIT_MIN_FILE_COUNT) return { decision: 'merge', reason: 'single-file' };
  if (count > SPLIT_MAX_FILE_COUNT) return { decision: 'merge', reason: 'count-exceeds-cap' };

  const stems = files.map(f => basename(f.path, extname(f.path)));

  if (stems.some(s => MERGE_MARKER_RE.test(s))) {
    return { decision: 'merge', reason: 'chapter-disc-part-marker' };
  }
  if (count >= NUMERIC_ONLY_MIN_COUNT && stems.every(s => NUMERIC_ONLY_RE.test(s))) {
    return { decision: 'merge', reason: 'numeric-only-stems' };
  }

  const largeFiles = files.filter(f => f.size >= COMPLETE_BOOK_MIN_SIZE).length;
  if (largeFiles / count < LARGE_FILE_RATIO) {
    return { decision: 'merge', reason: 'files-too-small-for-full-books' };
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

  return { decision: 'split', reason: 'distinct-large-files-no-marker' };
}

function normalizeStemForComparison(stem: string): string {
  return stem
    .replace(/^\d+\s*[-_.]\s*/, '')
    .replace(/^[A-Za-z][\w\s]*?\s+\d+\s*[-_.]\s*/, '')
    .replace(/\s+\d+\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}
