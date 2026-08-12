import { extname } from 'node:path';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import {
  tryTitleDashSeriesBook,
  tryCrossSegmentAgreement,
  tryLeadingPositionLeaf,
  trySeriesParen,
  tryBookOfSeriesDescriptor,
  isPureReleaseTagBracket,
  isReleaseTagInner,
} from './folder-parsing-patterns.js';
import {
  BARE_YEAR_REGEX,
  CODEC_TEST_REGEX,
  extractYear,
  isEditionParen,
  NARRATOR_PAREN_REGEX,
  normalizeFolderName,
  applyLastFirstSwap,
} from './folder-parsing-primitives.js';
import { TAG_TITLE_SERIES_MARKER_REGEX } from '@shared/dedup.js';

// Preserve the existing public import surface.
export { CODEC_TEST_REGEX, normalizeFolderName, extractYear };

function stripAudioExtension(segment: string): string {
  const ext = extname(segment).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return segment;
  const stripped = segment.slice(0, -ext.length);
  return stripped || segment;
}

// Series - N - Title; group 2 is the position.
const SERIES_NUMBER_TITLE_REGEX = /^(.+?)\s*[–-]\s*(\d+)\s*[–-]\s*(.+)$/;

const SERIES_MARKER_REGEX = /,\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

// Non-global because only the first bracketed Audible ASIN is extracted.
const ASIN_REGEX = /\[B0[A-Z0-9]{8}\]/i;

const NARRATOR_PREFIX_PAREN_REGEX = /\s*\((?:Read|Narrated)\s+by\b[^)]*\)\s*$/i;

const TRAILING_PAREN_REGEX = /\s*\(([^)]+)\)\s*$/;

// Tag titles use the shared extended marker regex; folder names require a comma to avoid false positives.
const SERIES_BOOK_DASH_TITLE_REGEX = /^(.+?),\s*book\s+(\d+)\s*-\s*(.+)$/i;

const KEBAB_CASE_REGEX = /^[a-z]+(?:-[a-z]+)+$/;

const WORDS_NUM_DASH_TITLE_REGEX = /^(.+?)\s+(\d+)\s*-\s*(.+)$/;

// P4/P10 must use the first dash; reject matches whose first capture already crosses one.
function matchFirstDashOnly(input: string, regex: RegExp): RegExpMatchArray | null {
  const m = input.match(regex);
  return m && !m[1]!.includes(' - ') ? m : null;
}

// Preserve date-like/numeric titles before destructive numeric and normalization rules.
const ALL_NUMERIC_SEGMENTS_REGEX = /^\d+(?:[-–./]\d+){1,2}$/;

function isAllNumericSegments(input: string): boolean {
  return ALL_NUMERIC_SEGMENTS_REGEX.test(input);
}

export interface CleanNameStep {
  name: string;
  output: string;
}

export interface CleanNameTraceResult {
  input: string;
  steps: CleanNameStep[];
  result: string;
}

export function cleanName(name: string): string {
  return cleanNameWithTrace(name).result;
}

/**
 * Tag titles preserve punctuation and edition labels. Strip bracket tags, then non-edition
 * trailing parens, then end-anchored series markers; that order is required.
 */
export function cleanTagTitle(s: string): string {
  let result = stripBracketTags(s);
  const m = result.match(NARRATOR_PAREN_REGEX);
  if (m && !isEditionParen(m[1]!)) result = result.replace(NARRATOR_PAREN_REGEX, '').trim() || result;
  return result.replace(TAG_TITLE_SERIES_MARKER_REGEX, '').trim() || s;
}

// A whole-tag volume marker carries no title; the album supplies it.
const PURE_VOLUME_MARKER_REGEX = /^(?:saga|trilogy|series|cycle|chronicles)?[\s,]*(?:book|vol(?:ume)?)\s+\d+$/i;

export function isPureVolumeMarker(s: string): boolean {
  return PURE_VOLUME_MARKER_REGEX.test(s.trim());
}

// A real prefix before a trailing marker is a series name, not a title.
export function hasTagSeriesMarker(s: string): boolean {
  return TAG_TITLE_SERIES_MARKER_REGEX.test(s);
}

/**
 * Strip release-tag brackets, but unwrap non-tag content when a full strip leaves no title.
 * This preserves [Dune] and Author - [Title] while still deleting codec/bitrate groups.
 */
function stripBracketTags(s: string): string {
  const stripped = s.replace(/\s*\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Recover only when stripping leaves empty or "Author -".
  if (stripped !== '' && !/\s[–-]\s*$/.test(stripped)) return stripped;
  const recovered = s
    .replace(/\s*\[([^\]]*)\]/g, (_full, inner: string) => {
      const trimmed = inner.trim();
      return trimmed !== '' && !isReleaseTagInner(trimmed) ? ` ${trimmed}` : ' ';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return recovered || stripped;
}

// Shared ordered pipeline keeps cleanName and trace output identical.
const CLEAN_NAME_PIPELINE: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ['leadingNumeric', s => s
    .replace(/^\d+\.\d+\s*[–-]\s*/, '')
    .replace(/^\d+[.\s]*[–-]\s*/, '')
    .replace(/^\d+\.(?!\d)\s*/, '')],
  ['seriesMarker', s => s.replace(SERIES_MARKER_REGEX, '')],
  ['normalize', s => normalizeFolderName(s)],
  ['yearParenStrip', s => s.replace(/\s*\(\d{4}\)$/, '')],
  // Preserve a whole-title year; bracketTagStrip will unwrap [1984].
  ['yearBracketStrip', s => { const out = s.replace(/\s*\[\d{4}\]$/, ''); return out.trim() ? out : s; }],
  ['bracketTagStrip', stripBracketTags],
  // Preserve a bare whole-title year.
  ['yearBareStrip', s => { const out = s.replace(BARE_YEAR_REGEX, ''); return out.trim() ? out : s; }],
  ['emptyParenStrip', s => s.replace(/\s*\(\s*\)/g, '')],
  ['emptyBracketStrip', s => s.replace(/\s*\[\s*\]/g, '').trim()],
  ['narratorPrefixStrip', s => {
    const stripped = s.replace(NARRATOR_PREFIX_PAREN_REGEX, '').trim();
    return stripped && stripped !== s ? stripped : s;
  }],
  ['editionParenStrip', s => {
    const m = s.match(TRAILING_PAREN_REGEX);
    if (!m || !isEditionParen(m[1]!)) return s;
    const stripped = s.replace(TRAILING_PAREN_REGEX, '').trim();
    return stripped || s;
  }],
  ['narratorParen', s => {
    const m = s.match(NARRATOR_PAREN_REGEX);
    if (!m || CODEC_TEST_REGEX.test(m[1]!)) return s;
    const stripped = s.replace(NARRATOR_PAREN_REGEX, '').trim();
    return stripped || s;
  }],
  ['dedup', s => {
    const parts = s.split(/\s*[–-]\s*/);
    if (parts.length !== 2) return s;
    const left = parts[0]!.replace(SERIES_MARKER_REGEX, '').replace(/\s*\d+\s*$/, '').trim();
    const right = parts[1]!.trim();
    return (left.toLowerCase() === right.toLowerCase() && right) ? right : s;
  }],
  // Run last so tag collapse can expose a dangling dash; never empty the title.
  ['trailingDash', s => s.replace(/\s*[–—-]\s*$/, '').trim() || s],
];

export function cleanNameWithTrace(name: string): CleanNameTraceResult {
  // Cleaning would corrupt date-like numeric titles.
  if (isAllNumericSegments(name)) {
    const steps = CLEAN_NAME_PIPELINE.map(([stepName]) => ({ name: stepName, output: name }));
    return { input: name, steps, result: name };
  }

  const steps: CleanNameStep[] = [];
  let current = name;
  for (const [stepName, fn] of CLEAN_NAME_PIPELINE) {
    current = fn(current);
    steps.push({ name: stepName, output: current });
  }
  // Fall back to raw only for real text; pure release-tag brackets must remain empty.
  return { input: name, steps, result: current || (isPureReleaseTagBracket(name) ? '' : name.trim()) };
}

/** Extracts and uppercases the first bracketed Audible ASIN, returning the remaining text. */
export function extractASIN(input: string): { asin: string | undefined; cleaned: string } {
  const match = input.match(ASIN_REGEX);
  if (!match) {
    return { asin: undefined, cleaned: input };
  }
  const asin = match[0].slice(1, -1).toUpperCase();
  const cleaned = input.replace(match[0], '').replace(/\s{2,}/g, ' ').trim();
  return { asin, cleaned };
}

export type ParsedFolder = {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
};

// Cleaned and raw parsers share author-title forms and P10 postprocessing.
function tryAuthorTitleForms(
  input: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): ParsedFolder | null {
  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch) {
    const left = dashMatch[1]!.trim();
    const right = dashMatch[2]!.trim();
    // A pure-tag right side falls through; a pure-tag left side makes the right title-only.
    if (!isPureReleaseTagBracket(right)) {
      if (isPureReleaseTagBracket(left)) return applyP10Postprocess(right, null, asinTail, transform);
      if (!/^\d+$/.test(left)) return applyP10Postprocess(right, applyLastFirstSwap(transform(left)), asinTail, transform);
    }
  }
  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1]!.trim();
    const right = byMatch[2]!.trim();
    if (right && !/^\d+$/.test(left)) {
      return applyP10Postprocess(left, applyLastFirstSwap(transform(right)), asinTail, transform);
    }
  }
  return null;
}

// Strip a trailing series-position paren before parsing so it cannot leak into author, then overlay it.
function applySeriesParen(
  input: string,
  asinTail: { asin?: string },
  parser: (folder: string) => ParsedFolder,
  transform: (s: string) => string,
): ParsedFolder | null {
  const sp = trySeriesParen(input);
  if (!sp) return null;
  return { ...parser(sp.remainder), series: transform(sp.series), seriesPosition: sp.seriesPosition, ...asinTail };
}

// Multi-part variant: parse the paren-free title, overlay position, and let folder/chain series win.
function withTitleSegmentSeriesParen(
  titleSegment: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
  chain: (remainder: string) => ParsedFolder,
): ParsedFolder {
  const sp = trySeriesParen(titleSegment);
  const base = chain(sp ? sp.remainder : titleSegment);
  if (!sp) return base;
  return {
    ...base,
    series: base.series ?? transform(sp.series),
    seriesPosition: sp.seriesPosition,
    ...asinTail,
  };
}

// Order: explicit series-position → P10 → cross-segment agreement → folder fallback.
function parseTwoPartTitleSegment(
  authorSegment: string,
  titleSegment: string,
  p8Author: string,
  p8Series: string | null,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): ParsedFolder {
  const seriesMatch = titleSegment.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesMatch) return seriesPosResult(seriesMatch, p8Author, asinTail, transform);
  const p10TwoPart = matchFirstDashOnly(titleSegment, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10TwoPart) return seriesPosResult(p10TwoPart, p8Author, asinTail, transform);
  const cs = tryCrossSegmentAgreement(authorSegment, titleSegment, asinTail, transform);
  return cs ?? { title: transform(titleSegment), author: p8Author, series: p8Series, ...asinTail };
}

// Cross-segment agreement precedes bare-position capture when the series itself starts with digits.
// Folder author/series remain authoritative; callers strip any trailing series-position paren first.
function parseThreePartTitleSegment(
  seriesFolder: string,
  titleSegment: string,
  author: string,
  series: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): ParsedFolder {
  // These patterns run before cleanName's numeric-title guard.
  if (!isAllNumericSegments(titleSegment)) {
    const cs = tryCrossSegmentAgreement(seriesFolder, titleSegment, asinTail, transform);
    if (cs) return { ...cs, author, series };
    const leading = tryLeadingPositionLeaf(titleSegment);
    if (leading) {
      return { title: transform(leading.remainder), author, series, seriesPosition: leading.seriesPosition, ...asinTail };
    }
  }
  return { title: transform(titleSegment), author, series, ...asinTail };
}

function parseSingleFolder(folder: string): ParsedFolder {
  const { asin, cleaned } = extractASIN(folder);
  const input = cleaned || folder;
  const asinTail = asin !== undefined ? { asin } : {};

  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  const seriesParen = applySeriesParen(input, asinTail, parseSingleFolder, cleanName);
  if (seriesParen) return seriesParen;

  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) return seriesPosResult(seriesNumberMatch, null, asinTail, cleanName);

  const seriesBookMatch = matchFirstDashOnly(input, SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) return seriesPosResult(seriesBookMatch, null, asinTail, cleanName);

  const titleDashSeries = tryTitleDashSeriesBook(input, asinTail, cleanName);
  if (titleDashSeries) return titleDashSeries;

  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: cleanName(input), author: null, series: null, ...asinTail };
  }

  const p10Pre = matchFirstDashOnly(input, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre) return seriesPosResult(p10Pre, null, asinTail, cleanName);

  const bookOfSeries = tryBookOfSeriesDescriptor(input, asinTail, cleanName,
    (residual) => tryAuthorTitleForms(residual, asinTail, cleanName));
  if (bookOfSeries) return bookOfSeries;

  const authorTitle = tryAuthorTitleForms(input, asinTail, cleanName);
  if (authorTitle) return authorTitle;

  return {
    title: cleaned ? cleanName(input) : cleanName(folder),
    author: null,
    series: null,
    ...asinTail,
  };
}

const identity = (s: string): string => s;

function seriesPosResult(
  match: RegExpMatchArray,
  author: string | null,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): { title: string; author: string | null; series: string; seriesPosition: number; asin?: string } {
  return {
    title: transform(match[3]!),
    author,
    series: transform(match[1]!),
    seriesPosition: parseFloat(match[2]!),
    ...asinTail,
  };
}

// Match before cleaning so a tag-only subtitle can collapse without losing series and position.
function applyP10Postprocess(
  rawTitle: string,
  author: string | null,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): { title: string; author: string | null; series: string | null; seriesPosition?: number; asin?: string } {
  const m = rawTitle.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (!m) return { title: transform(rawTitle), author, series: null, ...asinTail };
  return seriesPosResult(m, author, asinTail, transform);
}

/** Parses one-part, Author/Title, and Author/Series/Title folder layouts. */
export function parseFolderStructure(parts: string[]): ParsedFolder {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  if (parts.length === 1) {
    const folder = stripAudioExtension(parts[0]!);
    return parseSingleFolder(folder);
  }

  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(stripAudioExtension(parts[1]!));
    const titleSegment = cleaned || stripAudioExtension(parts[1]!);

    const { author: p8Author, series: p8Series } = splitAuthorSegment(parts[0]!, parseSingleFolder, cleanName);

    if (isAllNumericSegments(titleSegment)) {
      return {
        title: titleSegment,
        author: p8Author,
        series: p8Series,
        ...(asin !== undefined && { asin }),
      };
    }
    const asinTail = asin !== undefined ? { asin } : {};
    return withTitleSegmentSeriesParen(titleSegment, asinTail, cleanName, (remainder) =>
      parseTwoPartTitleSegment(parts[0]!, remainder, p8Author, p8Series, asinTail, cleanName));
  }

  const lastSegment = stripAudioExtension(parts[parts.length - 1]!);
  const { asin, cleaned } = extractASIN(lastSegment);
  const titleSegment = cleaned || lastSegment;
  const asinTail = asin !== undefined ? { asin } : {};
  const folderSeries = cleanName(parts[parts.length - 2]!);
  return withTitleSegmentSeriesParen(titleSegment, asinTail, cleanName, (remainder) =>
    parseThreePartTitleSegment(
      parts[parts.length - 2]!, remainder, cleanName(parts[0]!), folderSeries, asinTail, cleanName));
}

// Split only ASCII " - "; raw and cleaned callers supply their own parser and transform.
function splitAuthorSegment(
  segment: string,
  parser: typeof parseSingleFolder | typeof parseSingleFolderRaw,
  transform: (s: string) => string,
): { author: string; series: string | null } {
  if (!segment.includes(' - ')) return { author: transform(segment), series: null };
  const sub = parser(segment);
  if (sub.author && sub.title) return { author: sub.author, series: sub.title };
  return { author: transform(segment), series: null };
}

/** Returns pre-cleanName values so scan-debug traces start from actual segments. */
export function parseFolderStructureRaw(parts: string[]): ParsedFolder {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  if (parts.length === 1) {
    return parseSingleFolderRaw(stripAudioExtension(parts[0]!));
  }

  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(stripAudioExtension(parts[1]!));
    const titleSegment = cleaned || stripAudioExtension(parts[1]!);

    const { author: p8Author, series: p8Series } = splitAuthorSegment(parts[0]!, parseSingleFolderRaw, identity);

    if (isAllNumericSegments(titleSegment)) {
      return { title: titleSegment, author: p8Author, series: p8Series, ...(asin !== undefined && { asin }) };
    }
    const asinTail = asin !== undefined ? { asin } : {};
    return withTitleSegmentSeriesParen(titleSegment, asinTail, identity, (remainder) =>
      parseTwoPartTitleSegment(parts[0]!, remainder, p8Author, p8Series, asinTail, identity));
  }

  const lastSegment = stripAudioExtension(parts[parts.length - 1]!);
  const { asin, cleaned } = extractASIN(lastSegment);
  const titleSegment = cleaned || lastSegment;
  const asinTail = asin !== undefined ? { asin } : {};
  const folderSeries = parts[parts.length - 2]!;
  return withTitleSegmentSeriesParen(titleSegment, asinTail, identity, (remainder) =>
    parseThreePartTitleSegment(
      parts[parts.length - 2]!, remainder, parts[0]!, folderSeries, asinTail, identity));
}

function parseSingleFolderRaw(folder: string): ParsedFolder {
  const { asin, cleaned } = extractASIN(folder);
  const input = cleaned || folder;
  const asinTail = asin !== undefined ? { asin } : {};

  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  const seriesParen = applySeriesParen(input, asinTail, parseSingleFolderRaw, identity);
  if (seriesParen) return seriesParen;

  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) return seriesPosResult(seriesNumberMatch, null, asinTail, identity);

  const seriesBookMatch = matchFirstDashOnly(input, SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) return seriesPosResult(seriesBookMatch, null, asinTail, identity);

  const titleDashSeries = tryTitleDashSeriesBook(input, asinTail, identity);
  if (titleDashSeries) return titleDashSeries;

  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  const p10Pre = matchFirstDashOnly(input, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre) return seriesPosResult(p10Pre, null, asinTail, identity);

  const bookOfSeries = tryBookOfSeriesDescriptor(input, asinTail, identity,
    (residual) => tryAuthorTitleForms(residual, asinTail, identity));
  if (bookOfSeries) return bookOfSeries;

  const authorTitle = tryAuthorTitleForms(input, asinTail, identity);
  if (authorTitle) return authorTitle;

  return { title: cleaned ? input : folder, author: null, series: null, ...asinTail };
}
