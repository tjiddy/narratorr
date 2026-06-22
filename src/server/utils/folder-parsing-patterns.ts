// Pattern helpers for folder-parsing.ts (issue #1034). Extracted to keep the
// main module under the file-size cap; behaviour is unchanged from inlining.

import { CODEC_TEST_REGEX, isEditionParen, NARRATOR_PAREN_REGEX, applyLastFirstSwap } from './folder-parsing-primitives.js';
import type { ParsedFolder } from './folder-parsing.js';

/**
 * `<title> - <series>, Book N [by Author] [(Narrator)]` — rightmost-dash split.
 * Greedy `(.+)` + non-greedy `(.+?)` + `, Book N` anchor walks the engine to
 * the rightmost ` - ` that produces a valid match. The series side allows
 * internal dashes (required for `The Three-Body Problem`-style titles).
 */
const TITLE_DASH_SERIES_BOOK_REGEX = /^(.+)\s+-\s+(.+?)\s*,\s*Book\s+(\d+(?:\.\d+)?)\s*(?:by\s+(.+?))?\s*(?:\(([^)]+)\))?\s*$/i;

const SERIES_KEYWORD_REGEX = /\b(?:series|saga|chronicles|trilogy|cycle)\b/i;

/** Release-tag phrases NOT in `CODEC_TAGS` (which covers single codec/format labels
 * only); denied from `bracketTagStrip`'s whole-title unwrap as release metadata,
 * not titles. Compared case-insensitively against the normalized inner. (#1331) */
const TAG_PHRASE_DENYLIST = new Set(
  ['Graphic Audio', 'GraphicAudio', 'GA', 'Dramatized Adaptation', 'Dramatized', 'Full Cast', 'Full-Cast']
    .map((p) => p.toLowerCase()),
);
// `isReleaseTagInner` splits the inner on whitespace before testing each token,
// so a token never contains an internal space — the dead `\s*` matcher these
// regexes carried pre-#1332 could never fire and is dropped.
const BITRATE_TOKEN_REGEX = /^\d+(?:\.\d+)?k(bps)?$/i; // `64k`, `128kbps`
const SAMPLE_RATE_TOKEN_REGEX = /^\d+(?:\.\d+)?khz$/i; // `22khz`, `44khz`, joined `44.1khz`
/** Bare numeric / decimal token — a filler digit inside a multi-token tag, e.g.
 * the `44` left over when `normalize` dot-splits `44.1kHz` → `44 1kHz`, or the
 * `64` in a spaced `64 kbps`. A LONE numeric inner is NOT a tag (it is a title
 * like `[1984]` / `[22]`), so the classifier requires ≥1 strong tag token too. */
const BARE_NUMERIC_TOKEN_REGEX = /^\d+(?:\.\d+)?$/;
/** Bare unit token left when a sample-rate / bitrate is spaced from its number
 * (`64 kbps` → `64` `kbps`, `44.1 kHz` → `44.1` `khz`). */
const UNIT_TOKEN_REGEX = /^(?:k|kb|kbps|kbit|khz|hz|mhz|mb|mbps|vbr|cbr)$/i;
/** Audible ASIN shape — defensive: `extractASIN` removes ASIN brackets before the
 * clean pipeline, but a second ASIN bracket would survive to here. */
const ASIN_TOKEN_REGEX = /^B0[A-Z0-9]{8}$/i;
/** Strip leading/trailing token punctuation so `64k,` / `-` (from `[64k, 22khz]`,
 * `[MP3 - 64k]`) reduce to bare tag tokens / empty separators. */
const TOKEN_PUNCT_STRIP_REGEX = /^[-–—,]+|[-–—,]+$/g;

/** A `strong` tag token carries release-metadata meaning on its own (codec, bitrate,
 * sample rate, spaced unit, ASIN) — distinct from a bare numeric filler token. */
function isStrongReleaseTagToken(t: string): boolean {
  return CODEC_TEST_REGEX.test(t) || BITRATE_TOKEN_REGEX.test(t) || SAMPLE_RATE_TOKEN_REGEX.test(t)
    || UNIT_TOKEN_REGEX.test(t) || ASIN_TOKEN_REGEX.test(t);
}

/**
 * True when `trimmedInner` is entirely release-tag tokens (codec/format label,
 * bitrate `64k`, sample rate `22khz`, spaced unit `64 kbps`, dot-split `44 1khz`)
 * or a known release-tag phrase (`Graphic Audio`). Such inners are release
 * metadata, so the bracket-tag strip keeps deleting them rather than unwrapping.
 * A LONE bare numeric (`1984`, `22`) is a TITLE, not a tag — the classifier only
 * fires when every token is a strong tag or numeric filler AND at least one strong
 * tag is present. Any other non-tag token ⇒ `false`. Exported for tests. (#1331/#1332)
 */
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

/** True when `segment` is wholly a SEQUENCE of bracketed release tags — one or more
 * `[...]` groups with no other text, every inner passing `isReleaseTagInner`
 * (`[Graphic Audio]`, `[64k 22khz]`, `[Graphic Audio] [64k 22khz]`). Used by the
 * author/title dash split so a pure-tag segment (on either side) is never treated
 * as a title or author, and by the shared cleanName collapse guard. (#1331/#1332) */
export function isPureReleaseTagBracket(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed.startsWith('[')) return false;
  // Reject if any non-bracket text remains once every `[...]` group is removed.
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
 * Trailing parenthetical series marker: `(Series Name Book N)`, `(Series Name Vol|Volume N)`,
 * or `(Series Name #N)`. Series name is the non-greedy left capture (group 1); position is
 * either the Book/Vol number (group 2, Arabic decimal or Roman) or the hash number (group 3).
 * Anchored at end-of-string so it only consumes a true trailing paren.
 */
const SERIES_PAREN_REGEX =
  /\s*\((.+?)\s+(?:(?:book|vol(?:ume)?)\s+(\d+(?:\.\d+)?|[ivxlcdm]+)|#\s*(\d+(?:\.\d+)?))\)\s*$/i;

/**
 * Extract a trailing `(Series Name Book|Vol|Volume N)` / `(Series Name #N)` paren from an
 * input, returning the paren-stripped remainder plus the raw series name and numeric position.
 * Returns null when the paren is absent, when the captured series name is actually a codec
 * (`Unabridged`) or edition (`2nd Edition`) label rather than a series, when the position can't
 * be parsed, or when stripping the paren would leave nothing. Callers apply their own
 * cleanName/identity transform to the returned series name.
 */
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

/**
 * Anchored descriptor: a full ` - `-delimited segment that IS a
 * `Book N of [the] <Series> Series|Saga|Trilogy|Cycle|Chronicles` unit (#1271).
 * The series-keyword tail is part of the anchor, so a bare title word like
 * "The Saga of Pliocene Exile" (no leading `Book N of`) never matches. Group 1 is
 * the position (Arabic decimal or Roman); group 2 is the series name.
 */
const BOOK_OF_SERIES_DESCRIPTOR_REGEX =
  /^Book\s+(\d+(?:\.\d+)?|[IVXLCDM]+)\s+of\s+(?:the\s+)?(.+?)\s+(?:series|saga|trilogy|cycle|chronicles)\s*$/i;

/** Split an input into ` - ` / ` – ` / ` — `-delimited segments (each trimmed). */
function splitDashSegments(input: string): string[] {
  return input.split(/\s+[-–—]\s+/).map((s) => s.trim());
}

/** Locate the first segment that IS a `Book N of <Series> Saga` descriptor. */
function findDescriptorSegment(segments: string[]): { index: number; match: RegExpMatchArray } | null {
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i]!.match(BOOK_OF_SERIES_DESCRIPTOR_REGEX);
    if (match) return { index: i, match };
  }
  return null;
}

/** Build the `{ series, seriesPosition? }` overlay captured from a descriptor match. */
function descriptorSeriesOverlay(
  match: RegExpMatchArray,
  transform: (s: string) => string,
): { series: string; seriesPosition?: number } {
  const position = parseRomanOrArabicPosition(match[1]!);
  const series = transform(match[2]!.trim());
  return position !== undefined ? { series, seriesPosition: position } : { series };
}

/**
 * Recognize an inline `Book N of [the] <Series> Series|Saga|Trilogy|Cycle|Chronicles`
 * descriptor segment and resolve title/author around it (#1271). Two structural shapes:
 *
 * - **Trailing descriptor** — `Author - Title - <descriptor>`: strip the descriptor and let
 *   the existing `Author - Title` first-dash heuristic (`resolveAuthorTitle`) resolve the
 *   remainder.
 * - **Middle descriptor** — `Title - <descriptor> - Author`: the real author is the TRAILING
 *   segment and the real title is the LEADING segment, so assign them directly — a naive strip
 *   would leave `Title - Author`, which the first-dash heuristic would invert.
 *
 * The series-keyword tail is part of the anchored segment match, so a bare title word
 * (`The Saga of Pliocene Exile`, `The Chronicles of Amber`) never triggers the strip. Returns
 * null when no descriptor segment is present, when it sits at the leading edge with trailing
 * content (no title to assign), or when stripping would blank the name (degenerate
 * `Book 1 of the Series` falls through to the title-only path). `transform` is `cleanName`
 * for the cleaned parser, `identity` for raw — both paths run this branch identically.
 */
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

  // Trailing descriptor — strip it, reuse the existing dash/by heuristic on the remainder.
  if (found.index === segments.length - 1) {
    const residual = segments.slice(0, found.index).join(' - ');
    if (!residual) return null; // descriptor-only — fall back to the title-only path (AC6)
    const resolved = resolveAuthorTitle(residual)
      ?? { title: transform(residual), author: null, series: null, ...asinTail };
    return { ...resolved, ...overlay, ...asinTail };
  }

  // Middle descriptor — leading segment is the title, trailing segment(s) the author.
  if (found.index === 0) return null; // no leading title segment to assign
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
