// Pattern helpers for folder-parsing.ts (issue #1034). Extracted to keep the
// main module under the file-size cap; behaviour is unchanged from inlining.

import { CODEC_TEST_REGEX, isEditionParen, NARRATOR_PAREN_REGEX, applyLastFirstSwap } from './folder-parsing.js';

/**
 * `<title> - <series>, Book N [by Author] [(Narrator)]` — rightmost-dash split.
 * Greedy `(.+)` + non-greedy `(.+?)` + `, Book N` anchor walks the engine to
 * the rightmost ` - ` that produces a valid match. The series side allows
 * internal dashes (required for `The Three-Body Problem`-style titles).
 */
const TITLE_DASH_SERIES_BOOK_REGEX = /^(.+)\s+-\s+(.+?)\s*,\s*Book\s+(\d+(?:\.\d+)?)\s*(?:by\s+(.+?))?\s*(?:\(([^)]+)\))?\s*$/i;

const SERIES_KEYWORD_REGEX = /\b(?:series|saga|chronicles|trilogy|cycle)\b/i;

function isNarratorDisambiguatorParen(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (CODEC_TEST_REGEX.test(trimmed)) return false;
  if (isEditionParen(trimmed)) return false;
  return NARRATOR_PAREN_REGEX.test(`(${trimmed})`);
}

function hasTitleDashSeriesDisambiguator(match: RegExpMatchArray): boolean {
  const series = match[2] ?? '';
  const byAuthor = match[4];
  const parenContent = match[5];
  if (byAuthor && byAuthor.trim()) return true;
  if (SERIES_KEYWORD_REGEX.test(series)) return true;
  if (parenContent !== undefined && isNarratorDisambiguatorParen(parenContent)) return true;
  return false;
}

/**
 * Match `TITLE_DASH_SERIES_BOOK_REGEX` and (if disambiguator passes) return
 * the resolved record. `transform` is `cleanName` for the cleaned parser,
 * `identity` for the raw parser. Returns null when the pattern doesn't fire.
 */
export function tryTitleDashSeriesBook(
  input: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): { title: string; author: string | null; series: string; seriesPosition: number; asin?: string } | null {
  const m = input.match(TITLE_DASH_SERIES_BOOK_REGEX);
  if (!m || !hasTitleDashSeriesDisambiguator(m)) return null;
  const byAuthor = m[4];
  const author = byAuthor && byAuthor.trim() ? applyLastFirstSwap(transform(byAuthor.trim())) : null;
  return {
    title: transform(m[1]!),
    author,
    series: transform(m[2]!),
    seriesPosition: parseFloat(m[3]!),
    ...asinTail,
  };
}

/**
 * Cross-segment agreement: `<series-prefix> <position> <separator> <title>`.
 * Position can be Arabic (1, 01, 0.15) or Roman (I, IV, XII). Separator is
 * hyphen, en-dash, em-dash, underscore, or colon, with optional whitespace.
 */
const SERIES_PREFIX_POSITION_REGEX = /^(.+?)\s+(\d+(?:\.\d+)?|[IVX]+)\s*[-–—_:]\s*(.+)$/i;

const CROSS_SEGMENT_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or',
  'series', 'saga', 'chronicles', 'trilogy', 'cycle', 'book',
]);

function distinctiveTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/\s+/).filter((t) => t && !CROSS_SEGMENT_STOPWORDS.has(t)),
  );
}

const ROMAN_NUMERAL_MAP: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/**
 * Parse a captured position string as Arabic decimal or Roman numeral.
 * Returns `undefined` for unparseable input — defensive guard so callers
 * never emit `seriesPosition: undefined` (incompatible with exactOptionalPropertyTypes).
 */
function parseRomanOrArabicPosition(s: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : undefined;
  }
  let result = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = ROMAN_NUMERAL_MAP[s[i]!.toUpperCase()];
    if (v === undefined) return undefined;
    result += v < prev ? -v : v;
    prev = v;
  }
  return result || undefined;
}

/**
 * 2-part path: when the series-folder name shares a distinctive (non-stopword)
 * token with the filename's series prefix, treat the folder as the series and
 * the filename's `<series-prefix> <position> <separator> <title>` as the book.
 * Returns null when the position can't be parsed (preserves
 * exactOptionalPropertyTypes — never emits seriesPosition: undefined).
 */
export function tryCrossSegmentAgreement(
  seriesFolder: string,
  titleSegment: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): { title: string; author: null; series: string; seriesPosition: number; asin?: string } | null {
  const m = titleSegment.match(SERIES_PREFIX_POSITION_REGEX);
  if (!m) return null;
  const folderTokens = distinctiveTokens(seriesFolder);
  const prefixTokens = distinctiveTokens(m[1]!);
  if (![...prefixTokens].some((t) => folderTokens.has(t))) return null;
  const position = parseRomanOrArabicPosition(m[2]!);
  if (position === undefined) return null;
  return {
    title: transform(m[3]!),
    author: null,
    series: transform(seriesFolder),
    seriesPosition: position,
    ...asinTail,
  };
}
