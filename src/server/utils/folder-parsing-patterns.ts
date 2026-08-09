import { CODEC_TEST_REGEX, isEditionParen, isYearInWindow, NARRATOR_PAREN_REGEX, applyLastFirstSwap } from './folder-parsing-primitives.js';
import type { ParsedFolder } from './folder-parsing.js';

// Match the rightmost viable " - " before "<series>, Book N"; series may contain dashes.
const TITLE_DASH_SERIES_BOOK_REGEX = /^(.+)\s+-\s+(.+?)\s*,\s*Book\s+(\d+(?:\.\d+)?)\s*(?:by\s+(.+?))?\s*(?:\(([^)]+)\))?\s*$/i;

const SERIES_KEYWORD_REGEX = /\b(?:series|saga|chronicles|trilogy|cycle)\b/i;

// Multi-word release tags not covered by CODEC_TAGS.
const TAG_PHRASE_DENYLIST = new Set(
  ['Graphic Audio', 'GraphicAudio', 'GA', 'Dramatized Adaptation', 'Dramatized', 'Full Cast', 'Full-Cast']
    .map((p) => p.toLowerCase()),
);
const BITRATE_TOKEN_REGEX = /^\d+(?:\.\d+)?k(bps)?$/i; // `64k`, `128kbps`
const SAMPLE_RATE_TOKEN_REGEX = /^\d+(?:\.\d+)?khz$/i; // `22khz`, `44khz`, joined `44.1khz`
// Numeric fillers belong to multi-token tags, but a lone numeric bracket is a title.
const BARE_NUMERIC_TOKEN_REGEX = /^\d+(?:\.\d+)?$/;
const UNIT_TOKEN_REGEX = /^(?:k|kb|kbps|kbit|khz|hz|mhz|mb|mbps|vbr|cbr)$/i;
// A second ASIN bracket can survive extractASIN's first-match removal.
const ASIN_TOKEN_REGEX = /^B0[A-Z0-9]{8}$/i;
const TOKEN_PUNCT_STRIP_REGEX = /^[-–—,]+|[-–—,]+$/g;

function isStrongReleaseTagToken(t: string): boolean {
  return CODEC_TEST_REGEX.test(t) || BITRATE_TOKEN_REGEX.test(t) || SAMPLE_RATE_TOKEN_REGEX.test(t)
    || UNIT_TOKEN_REGEX.test(t) || ASIN_TOKEN_REGEX.test(t);
}

// Every token must be tag-like or numeric filler, with at least one strong tag.
// Requiring a strong token preserves bare numeric titles such as [1984].
export function isReleaseTagInner(trimmedInner: string): boolean {
  const normalized = trimmedInner.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (TAG_PHRASE_DENYLIST.has(normalized)) return true;
  const tokens = normalized.split(' ')
    .map((t) => t.replace(TOKEN_PUNCT_STRIP_REGEX, ''))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (!tokens.every((t) => isStrongReleaseTagToken(t) || BARE_NUMERIC_TOKEN_REGEX.test(t))) return false;
  return tokens.some(isStrongReleaseTagToken);
}

// Require bracket groups only, with release metadata in every inner.
export function isPureReleaseTagBracket(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed.startsWith('[')) return false;
  if (trimmed.replace(/\s*\[[^\]]*\]\s*/g, '').trim() !== '') return false;
  const inners = [...trimmed.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!.trim());
  return inners.length > 0 && inners.every((inner) => isReleaseTagInner(inner));
}

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

// Trailing series position in Book/Vol/Volume, Roman, or # forms.
const SERIES_PAREN_REGEX =
  /\s*\((.+?)\s+(?:(?:book|vol(?:ume)?)\s+(\d+(?:\.\d+)?|[ivxlcdm]+)|#\s*(\d+(?:\.\d+)?))\)\s*$/i;

// Reject codec/edition parens, invalid positions, and an empty remainder.
export function trySeriesParen(
  input: string,
): { remainder: string; series: string; seriesPosition: number } | null {
  const m = input.match(SERIES_PAREN_REGEX);
  if (!m) return null;
  const series = m[1]!.trim().replace(/,\s*$/, '');
  if (!series || CODEC_TEST_REGEX.test(series) || isEditionParen(series)) return null;
  const position = parseRomanOrArabicPosition(m[2] ?? m[3]!);
  if (position === undefined) return null;
  const remainder = input.replace(SERIES_PAREN_REGEX, '').trim();
  if (!remainder) return null;
  return { remainder, series, seriesPosition: position };
}

// `<series-prefix> <Arabic|Roman position> <separator> <title>`.
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

// Accept only when folder and filename prefix share a distinctive non-stopword token.
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

// Mirror leadingNumeric shapes so capturing position does not change titles; em dash stays excluded.
const LEADING_POSITION_REGEXES: readonly RegExp[] = [
  /^(\d+\.\d+)\s*[–-]\s*(.*)$/,
  /^(\d+)[.\s]*[–-]\s*(.*)$/,
  /^(\d+)\.(?!\d)\s*(.*)$/,
];

// Bare 1900–2099 prefixes collide with Plex year folders; suppress only literal four-digit forms.
// Cross-segment agreement has its own disambiguator and intentionally bypasses this guard.
function isYearShapedPositionLiteral(literal: string, position: number): boolean {
  return /^\d{4}$/.test(literal) && isYearInWindow(position);
}

// Require a lexical remainder; callers may later clean it to empty while retaining position.
export function tryLeadingPositionLeaf(
  segment: string,
): { remainder: string; seriesPosition: number } | null {
  for (const regex of LEADING_POSITION_REGEXES) {
    const m = segment.match(regex);
    if (!m) continue;
    const remainder = m[2]!.trim();
    if (!remainder) return null;
    const position = parseRomanOrArabicPosition(m[1]!);
    if (position === undefined || isYearShapedPositionLiteral(m[1]!, position)) return null;
    return { remainder, seriesPosition: position };
  }
  return null;
}

// The anchored series-keyword tail prevents bare titles such as "The Saga of Pliocene Exile" matching.
const BOOK_OF_SERIES_DESCRIPTOR_REGEX =
  /^Book\s+(\d+(?:\.\d+)?|[IVXLCDM]+)\s+of\s+(?:the\s+)?(.+?)\s+(?:series|saga|trilogy|cycle|chronicles)\s*$/i;

function splitDashSegments(input: string): string[] {
  return input.split(/\s+[-–—]\s+/).map((s) => s.trim());
}

function findDescriptorSegment(segments: string[]): { index: number; match: RegExpMatchArray } | null {
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i]!.match(BOOK_OF_SERIES_DESCRIPTOR_REGEX);
    if (match) return { index: i, match };
  }
  return null;
}

function descriptorSeriesOverlay(
  match: RegExpMatchArray,
  transform: (s: string) => string,
): { series: string; seriesPosition?: number } {
  const position = parseRomanOrArabicPosition(match[1]!);
  const series = transform(match[2]!.trim());
  return position !== undefined ? { series, seriesPosition: position } : { series };
}

// Trailing descriptors reuse author-title parsing; middle descriptors are Title - descriptor - Author.
// Assign the middle form directly so the first-dash heuristic cannot invert title and author.
export function tryBookOfSeriesDescriptor(
  input: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
  resolveAuthorTitle: (residual: string) => ParsedFolder | null,
): ParsedFolder | null {
  const segments = splitDashSegments(input);
  if (segments.length < 2) return null;
  const found = findDescriptorSegment(segments);
  if (!found) return null;
  const overlay = descriptorSeriesOverlay(found.match, transform);

  if (found.index === segments.length - 1) {
    const residual = segments.slice(0, found.index).join(' - ');
    if (!residual) return null;
    const resolved = resolveAuthorTitle(residual)
      ?? { title: transform(residual), author: null, series: null, ...asinTail };
    return { ...resolved, ...overlay, ...asinTail };
  }

  if (found.index === 0) return null;
  const title = segments.slice(0, found.index).join(' - ');
  const author = segments.slice(found.index + 1).join(' - ');
  if (!title) return null;
  return {
    title: transform(title),
    author: author ? applyLastFirstSwap(transform(author)) : null,
    ...overlay,
    ...asinTail,
  };
}
