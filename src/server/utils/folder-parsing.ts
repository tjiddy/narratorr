// ─── Folder Parsing & Cleaning ──────────────────────────────────────
// Extracted from library-scan.service.ts for shared use by scan and debug endpoints.
// All functions are pure (no `this`, no I/O).

import { extname } from 'node:path';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import {
  tryTitleDashSeriesBook,
  tryCrossSegmentAgreement,
  trySeriesParen,
  tryBookOfSeriesDescriptor,
  isPureReleaseTagBracket,
  isReleaseTagInner,
} from './folder-parsing-patterns.js';

/**
 * Strip a recognized audio extension from a path segment. Used for single-file
 * book discoveries where folderParts ends with a filename like 'Book.m4b' —
 * downstream parsers expect folder-style names without extensions.
 */
function stripAudioExtension(segment: string): string {
  const ext = extname(segment).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return segment;
  const stripped = segment.slice(0, -ext.length);
  return stripped || segment;
}

// ─── Regex Constants ────────────────────────────────────────────────

/** Codec/format tags to strip from folder names (case-insensitive, word-boundary). */
const CODEC_TAGS = ['MP3', 'M4B', 'M4A', 'FLAC', 'OGG', 'AAC', 'Unabridged', 'Abridged'];
const CODEC_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'gi');
/** Non-global codec regex for `.test()` guards — no `lastIndex` state between calls. */
export const CODEC_TEST_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'i');

/** Matches a bare 4-digit year (1900–2099) at end of string. */
const BARE_YEAR_REGEX = /\b((?:19|20)\d{2})\s*$/;

/** Matches "Series – NN – Title" or "Series - NN - Title" (dash or en-dash separators). Captures NN as group 2. */
const SERIES_NUMBER_TITLE_REGEX = /^(.+?)\s*[–-]\s*(\d+)\s*[–-]\s*(.+)$/;

/** Matches trailing ", Book NN", ", Vol NN", ", Volume NN" series markers. */
const SERIES_MARKER_REGEX = /,\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

/**
 * Matches trailing parenthetical containing a person's name (1-3 words).
 * Does NOT match: years (2020), codec tags (handled by CODEC_REGEX), or long subtitles (>3 words).
 */
export const NARRATOR_PAREN_REGEX = /\s*\((?!(?:19|20)\d{2}\))(\S+(?:\s+\S+){0,2})\)\s*$/;

/** Matches an Audible ASIN in brackets: B0 + 8 alphanumeric chars (case-insensitive). Non-global. */
const ASIN_REGEX = /\[B0[A-Z0-9]{8}\]/i;

/** P5: trailing parens beginning with "Read by" or "Narrated by" — strip regardless of word count. */
const NARRATOR_PREFIX_PAREN_REGEX = /\s*\((?:Read|Narrated)\s+by\b[^)]*\)\s*$/i;

/**
 * P6 single-paren extractor (capture content of trailing parens). Used to gate
 * stripping on year-prefix / ordinal-prefix / edition keyword.
 */
const TRAILING_PAREN_REGEX = /\s*\(([^)]+)\)\s*$/;
const EDITION_PAREN_YEAR_PREFIX = /^(?:19|20)\d{2}\b/;
const EDITION_PAREN_ORDINAL_PREFIX = /^\d+(?:st|nd|rd|th)\b/i;
const EDITION_PAREN_KEYWORD = /\b(?:Edition|Recording|Cut|Version|Mix)\b/i;

export function isEditionParen(content: string): boolean {
  return EDITION_PAREN_YEAR_PREFIX.test(content)
    || EDITION_PAREN_ORDINAL_PREFIX.test(content)
    || EDITION_PAREN_KEYWORD.test(content);
}

/** Extended series-marker regex used by `cleanTagTitle` only.
 * Catches comma-prefixed AND space-prefixed forms: `, Book 9`, ` book 1`,
 * `trilogy book 1`, `saga book 5`, `series book 3`, `chronicles vol 2`.
 * cleanName uses the stricter comma-only `SERIES_MARKER_REGEX` because folder
 * names rely on the comma to disambiguate from titles ending in `<word> N`. */
const TAG_TITLE_SERIES_MARKER_REGEX = /[\s,]+(?:saga|trilogy|series|cycle|chronicles)?\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

/** P4: `Series, Book NN - Title` — only fires when the left of the first ` - ` ends with `, Book NN`. */
const SERIES_BOOK_DASH_TITLE_REGEX = /^(.+?),\s*book\s+(\d+)\s*-\s*(.+)$/i;

/** P15: whole input is lowercase kebab-case (letters + hyphens only, 2+ segments). */
const KEBAB_CASE_REGEX = /^[a-z]+(?:-[a-z]+)+$/;

/** P10: `<words> NN - <subtitle>` — used for both precheck (before dash heuristic) and postprocess (on resolved title). */
const WORDS_NUM_DASH_TITLE_REGEX = /^(.+?)\s+(\d+)\s*-\s*(.+)$/;

/** P9: `Last, First` author convention — exactly two name-shaped tokens around a comma. */
const LAST_FIRST_AUTHOR_REGEX = /^([\w'.-]+),\s*([\w'.-]+)$/;

/** Apply P9 swap: `Last, First` → `First Last`. No-op if pattern doesn't match. */
export function applyLastFirstSwap(author: string): string {
  const match = author.match(LAST_FIRST_AUTHOR_REGEX);
  if (match) return `${match[2]} ${match[1]}`;
  return author;
}

/**
 * Match `regex` against `input` but only return the match when group 1 has no
 * ` - ` — enforces "left of FIRST dash" boundary for P4 and P10-precheck so
 * inputs like `Author - Discworld, Book 16 - Title` fall through to the dash
 * heuristic instead of being preempted.
 */
function matchFirstDashOnly(input: string, regex: RegExp): RegExpMatchArray | null {
  const m = input.match(regex);
  return m && !m[1]!.includes(' - ') ? m : null;
}

/**
 * Matches inputs that are entirely numeric segments separated by dash, en-dash,
 * dot, or slash (e.g. '11-22-63', '11.22.63', '1-5', '1.5').
 * Used to short-circuit Series–NN–Title matching and the leading-numeric strip,
 * which would otherwise mangle date-like or numeric titles.
 */
const ALL_NUMERIC_SEGMENTS_REGEX = /^\d+(?:[-–./]\d+){1,2}$/;

/** True when the input is two or three digit-only segments joined by `-`, `–`, `.`, or `/`. */
function isAllNumericSegments(input: string): boolean {
  return ALL_NUMERIC_SEGMENTS_REGEX.test(input);
}

// ─── Trace Types ────────────────────────────────────────────────────

export interface CleanNameStep {
  name: string;
  output: string;
}

export interface CleanNameTraceResult {
  input: string;
  steps: CleanNameStep[];
  result: string;
}

// ─── Core Functions ─────────────────────────────────────────────────

/** Shared normalization: underscore/dot→space, codec strip, collapse whitespace, trim. */
export function normalizeFolderName(name: string): string {
  return name
    .replace(/[_.]/g, ' ')
    .replace(CODEC_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function cleanName(name: string): string {
  return cleanNameWithTrace(name).result;
}

/**
 * Clean a tag-derived title. Tag conventions differ from folder conventions:
 * tag titles preserve dots (`World War 3.1`), colons (`Eric: Discworld`),
 * dashes, and edition parens (`(2006)`, `(2006 Edition)`). The pipeline applies
 * exactly three transforms in this order:
 *   1. bracket-tag strip (`[Dramatized Adaptation]`, `[GA]`, etc.)
 *   2. trailing 1-3 word paren strip, gated by `isEditionParen` so true edition
 *      labels survive but media markers like `(Unabridged)` and narrator names
 *      are removed. Must run BEFORE step 3 — anchored series-marker regex
 *      requires the suffix to be at end-of-string.
 *   3. extended series-marker strip — comma- AND space-prefixed forms with
 *      optional series-keyword (saga/trilogy/series/cycle/chronicles).
 */
export function cleanTagTitle(s: string): string {
  let result = s.replace(/\s*\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const m = result.match(NARRATOR_PAREN_REGEX);
  if (m && !isEditionParen(m[1]!)) result = result.replace(NARRATOR_PAREN_REGEX, '').trim() || result;
  return result.replace(TAG_TITLE_SERIES_MARKER_REGEX, '').trim() || s;
}

/**
 * Strip bracketed release tags (`[M4B]`, `[64k]`, `[2021]`, `[GA]`) — but NOT when
 * doing so would leave a title-less remainder. When the whole title is wrapped in
 * brackets (`Author - [The Real Title]`), a global strip collapses the name to an
 * empty or author-only string (`Author -`), poisoning the metadata search (#1316).
 * In that case the brackets wrapped real content, not a tag, so we UNWRAP them —
 * keep the inner text, drop the brackets — and let downstream steps parse it as
 * plain text. The guard evaluates the remainder after the FULL strip (not per
 * bracket) so a legitimate trailing tag alongside real title text still strips.
 * Mirrors the `... || s` fallback-on-empty idiom in `cleanTagTitle`.
 */
function bracketTagStrip(s: string): string {
  const stripped = s.replace(/\s*\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Only intervene when the strip left a title-less remainder: empty, or
  // author-only like "Author -" (ends with a space-prefixed hyphen/en-dash and
  // nothing after). Anything with real title text keeps the normal strip.
  if (stripped !== '' && !/\s[–-]\s*$/.test(stripped)) return stripped;
  // The bracket(s) wrapped real content, not a tag. Unwrap only genuinely
  // MULTI-WORD inner text (a real title phrase like "Bobiverse 03 All These
  // Worlds – 3"); keep deleting single-token tags (codec/bitrate/year/format/ASIN:
  // [M4B], [64k], [2021], [B0D18DYG5C]) AND multi-token release tags ([64k 22khz],
  // [Graphic Audio], [Dramatized Adaptation]) so existing tag/ASIN strip survives.
  // Trim the inner BEFORE the multi-word test: `normalize` codec-strips inside
  // brackets ([MP3 64k] → [ 64k]), and the bare `/\s/` test on a leading-space
  // inner would wrongly unwrap the residual bitrate into the title (#1316/#1331).
  const recovered = s
    .replace(/\s*\[([^\]]*)\]/g, (_full, inner: string) => {
      const trimmed = inner.trim();
      return /\S\s+\S/.test(trimmed) && !isReleaseTagInner(trimmed) ? ` ${trimmed}` : ' ';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return recovered || stripped;
}

/** Pipeline steps for cleanName/cleanNameWithTrace. Order matters — see step names below. */
const CLEAN_NAME_PIPELINE: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ['leadingNumeric', s => s
    .replace(/^\d+\.\d+\s*[–-]\s*/, '')
    .replace(/^\d+[.\s]*[–-]\s*/, '')
    .replace(/^\d+\.(?!\d)\s*/, '')],
  ['seriesMarker', s => s.replace(SERIES_MARKER_REGEX, '')],
  ['normalize', s => normalizeFolderName(s)],
  ['yearParenStrip', s => s.replace(/\s*\(\d{4}\)$/, '')],
  ['yearBracketStrip', s => s.replace(/\s*\[\d{4}\]$/, '')],
  ['bracketTagStrip', bracketTagStrip],
  ['yearBareStrip', s => s.replace(BARE_YEAR_REGEX, '')],
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
];

/**
 * Trace-mode cleanName: runs the cleanName pipeline and records intermediate
 * output after each transformation step. cleanName() returns the final result;
 * both share the CLEAN_NAME_PIPELINE table so traces stay in sync.
 */
export function cleanNameWithTrace(name: string): CleanNameTraceResult {
  // All-numeric date-like inputs ('11-22-63', '1.5') are returned unchanged —
  // every pipeline step would corrupt them (leadingNumeric eats the first
  // segment, normalizeFolderName turns dots into spaces, etc.).
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
  return { input: name, steps, result: current || name.trim() };
}

// ─── ASIN Extraction ────────────────────────────────────────────────

/**
 * Extracts an Audible ASIN from bracket notation in a folder name.
 * Returns the uppercase-normalized ASIN and the cleaned input (bracket stripped).
 * Only the first match is extracted if multiple ASIN-like brackets exist.
 */
export function extractASIN(input: string): { asin: string | undefined; cleaned: string } {
  const match = input.match(ASIN_REGEX);
  if (!match) {
    return { asin: undefined, cleaned: input };
  }
  // Strip the bracket, normalize ASIN to uppercase (remove surrounding brackets)
  const asin = match[0].slice(1, -1).toUpperCase();
  const cleaned = input.replace(match[0], '').replace(/\s{2,}/g, ' ').trim();
  return { asin, cleaned };
}

// ─── Folder Structure Parsing ───────────────────────────────────────

/** Parsed single-folder / folder-structure shape (title + optional author/series/position/asin). */
export type ParsedFolder = {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
};

/**
 * Tail patterns shared by the cleaned and raw single-folder parsers: `Author - Title`
 * (skipped when the left side is a bare number) then `Title by Author`. Returns null when
 * neither fires. `transform` is cleanName (cleaned) or identity (raw); applyP10Postprocess
 * runs on the resolved title in both.
 */
function tryAuthorTitleForms(
  input: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): ParsedFolder | null {
  // Pattern: "Author - Title" (skip if left side is just a number like "01 - Title")
  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  // Don't split when the right side is a pure bracketed release tag (`[Graphic Audio]`,
  // `[Dramatized Adaptation]`, `[64k 22khz]`): a release tag is never a title and the
  // left side is the title, not the author. Splitting would mis-assign the author and,
  // because the bracket-only title segment collapses to empty and falls back to the raw
  // bracket, leak the tag text into the title. Falling through to the title-only path
  // yields the tag-deleted whole-string clean (`Wool Omnibus -`). (#1331)
  if (dashMatch && !/^\d+$/.test(dashMatch[1]!.trim()) && !isPureReleaseTagBracket(dashMatch[2]!)) {
    const author = applyLastFirstSwap(transform(dashMatch[1]!));
    return applyP10Postprocess(transform(dashMatch[2]!), author, asinTail, transform);
  }
  // Pattern: "Title by Author" (word-boundary, not inside words like "Standby")
  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1]!.trim();
    const right = byMatch[2]!.trim();
    // Guard: left side must not be just numbers, right side must be non-empty
    if (right && !/^\d+$/.test(left)) {
      return applyP10Postprocess(transform(left), applyLastFirstSwap(transform(right)), asinTail, transform);
    }
  }
  return null;
}

/**
 * Trailing `(Series Name Book|Vol N)` / `(Series Name #N)` paren overlay: strip the paren,
 * parse the remainder with `parser`, then overlay the extracted series + position. The series
 * paren is removed before the author/title branches run, so it never leaks into the author.
 * Returns null when no series paren is present.
 */
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

/**
 * Trailing `(Series Name Book|Vol N)` / `(Series Name #N)` paren handling for the multi-part
 * branches (2-part / 3+-part), where the author lives in a separate folder segment. Strips the
 * paren from the title segment, runs `chain` on the paren-FREE remainder (so downstream patterns —
 * `SERIES_NUMBER_TITLE_REGEX`, the P10 pre-check, cross-segment agreement — operate on the stripped
 * remainder and don't double-handle the paren), then overlays the paren's position and fills the
 * series name only when neither the folder nor the chain produced one. When no series paren is
 * present, returns `chain(titleSegment)` unchanged so callers behave exactly as before.
 *
 * Unlike `applySeriesParen`, this does NOT re-parse the remainder as a single folder — the author
 * is already a separate folder segment, so re-parsing would wrongly re-split it.
 */
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

/**
 * Shared 2-part title-segment pattern chain: `SERIES_NUMBER_TITLE_REGEX` (wins over P8's
 * series-from-author) → P10 pre-check → cross-segment agreement → fallback (folder-derived series).
 * `transform` selects cleaned (`cleanName`) vs raw (`identity`). Callers strip any trailing series
 * paren BEFORE invoking this via `withTitleSegmentSeriesParen`, so the chain sees the paren-free
 * remainder.
 */
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
  // P10-precheck (2-part): mirrors parseSingleFolder's p10Pre so flat-pack splits
  // like 'Sanderson/Mistborn 01 - The Final Empire.mp3' resolve series+position+title.
  const p10TwoPart = matchFirstDashOnly(titleSegment, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10TwoPart) return seriesPosResult(p10TwoPart, p8Author, asinTail, transform);
  const cs = tryCrossSegmentAgreement(authorSegment, titleSegment, asinTail, transform);
  return cs ?? { title: transform(titleSegment), author: p8Author, series: p8Series, ...asinTail };
}

function parseSingleFolder(folder: string): ParsedFolder {
  // Extract ASIN bracket before any other pattern matching
  const { asin, cleaned } = extractASIN(folder);
  // Use cleaned input for pattern matching; fall back to original if cleaned is empty
  const input = cleaned || folder;
  const asinTail = asin !== undefined ? { asin } : {};

  // Guard: all-numeric date-like inputs ('11-22-63', '1.5') are titles, not
  // Series–NN–Title — short-circuit before pattern matching.
  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  const seriesParen = applySeriesParen(input, asinTail, parseSingleFolder, cleanName);
  if (seriesParen) return seriesParen;

  // Pattern: "Series – NN – Title" or "Series - NN - Title"
  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) return seriesPosResult(seriesNumberMatch, null, asinTail, cleanName);

  // P4: "Series, Book NN - Title" — left of FIRST ` - ` ends with `, Book NN`.
  const seriesBookMatch = matchFirstDashOnly(input, SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) return seriesPosResult(seriesBookMatch, null, asinTail, cleanName);

  const titleDashSeries = tryTitleDashSeriesBook(input, asinTail, cleanName);
  if (titleDashSeries) return titleDashSeries;

  // P15: whole-input lowercase kebab-case → bail to title-only
  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: cleanName(input), author: null, series: null, ...asinTail };
  }

  // P10-precheck (no-author path): "<series> NN - <title>" with no ` - ` in series
  const p10Pre = matchFirstDashOnly(input, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre) return seriesPosResult(p10Pre, null, asinTail, cleanName);

  // #1271: "Book N of [the] <Series> Saga" descriptor — strip it and fix Title-first ordering.
  const bookOfSeries = tryBookOfSeriesDescriptor(input, asinTail, cleanName,
    (residual) => tryAuthorTitleForms(residual, asinTail, cleanName));
  if (bookOfSeries) return bookOfSeries;

  const authorTitle = tryAuthorTitleForms(input, asinTail, cleanName);
  if (authorTitle) return authorTitle;

  // Just a title — use original folder if cleaned was empty (ASIN-only input)
  return {
    title: cleaned ? cleanName(input) : cleanName(folder),
    author: null,
    series: null,
    ...asinTail,
  };
}

/** Identity transform — used as `transform` for raw parser variants that skip cleanName. */
const identity = (s: string): string => s;

/**
 * Build the canonical 3-capture seriesPosition return shape from a regex match.
 * Used by every `Series N - Title` branch (1-part, 2-part, P4, P10) — they all
 * produce identical { title, author, series, seriesPosition } output, just with
 * different captures and `transform` (cleanName for cleaned, identity for raw).
 */
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

/**
 * P10-postprocess (author-dash path): if a resolved title still looks like
 * `<series> NN - <subtitle>`, decompose it. Preserves the already-resolved author.
 * `transform` is `cleanName` for the cleaned parser, `identity` for raw.
 */
function applyP10Postprocess(
  title: string,
  author: string,
  asinTail: { asin?: string },
  transform: (s: string) => string,
): { title: string; author: string | null; series: string | null; seriesPosition?: number; asin?: string } {
  const m = title.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (!m) return { title, author, series: null, ...asinTail };
  return seriesPosResult(m, author, asinTail, transform);
}

/**
 * Parses folder path segments into author/title/series structure.
 * Supports 1-part (single folder), 2-part (Author/Title), and 3+-part (Author/Series/Title) layouts.
 *
 * Patterns for single-folder parsing:
 * - Author - Title
 * - Title by Author
 * - Series – NN – Title
 * - Title only
 */
export function parseFolderStructure(parts: string[]): ParsedFolder {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  // Single folder: try to parse "Author - Title" or other patterns
  if (parts.length === 1) {
    const folder = stripAudioExtension(parts[0]!);
    return parseSingleFolder(folder);
  }

  // Two folders: Author/Title (or Author/Series – NN – Title)
  // Extract ASIN from the title segment (2-part branch bypasses parseSingleFolder)
  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(stripAudioExtension(parts[1]!));
    const titleSegment = cleaned || stripAudioExtension(parts[1]!);

    // P8: detect "Author - Series" in author segment (ASCII hyphen only)
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
    // Strip any trailing `(Series Book N)` paren first, then run the existing dash/P10/cross-segment
    // chain on the paren-free remainder, overlaying the paren's position. Folder series name (P8)
    // stays authoritative; the paren only fills the name when neither folder nor chain produced one.
    return withTitleSegmentSeriesParen(titleSegment, asinTail, cleanName, (remainder) =>
      parseTwoPartTitleSegment(parts[0]!, remainder, p8Author, p8Series, asinTail, cleanName));
  }

  // Three or more folders: Author/Series/Title (take first, second-to-last, last)
  // Extract ASIN from the title segment (last part)
  const lastSegment = stripAudioExtension(parts[parts.length - 1]!);
  const { asin, cleaned } = extractASIN(lastSegment);
  const titleSegment = cleaned || lastSegment;
  const asinTail = asin !== undefined ? { asin } : {};
  const folderSeries = cleanName(parts[parts.length - 2]!);
  // Trailing `(Series Book N)` paren: strip from the title, take its position; the folder series
  // segment stays authoritative for the name (folder wins even if the paren names a different series).
  return withTitleSegmentSeriesParen(titleSegment, asinTail, cleanName, (remainder) => ({
    title: cleanName(remainder),
    author: cleanName(parts[0]!),
    series: folderSeries,
    ...asinTail,
  }));
}

/**
 * P8: split a 2-part `Author - Series` first segment into separate fields.
 * Falls back to whole-segment author when there's no ASCII ` - ` to split on
 * or the recursive parse can't resolve an author. `parser` selects cleaned vs raw.
 */
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

/**
 * Like parseFolderStructure, but returns the raw (pre-cleanName) values.
 * Used by the scan-debug endpoint to build cleaning traces from the actual
 * raw segments rather than the already-cleaned parser output.
 */
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

    // P8: split `Author - Series` from raw author segment
    const { author: p8Author, series: p8Series } = splitAuthorSegment(parts[0]!, parseSingleFolderRaw, identity);

    if (isAllNumericSegments(titleSegment)) {
      return { title: titleSegment, author: p8Author, series: p8Series, ...(asin !== undefined && { asin }) };
    }
    const asinTail = asin !== undefined ? { asin } : {};
    // Trailing `(Series Book N)` paren — mirrors the cleaned 2-part branch with `identity`: strip,
    // run the chain on the paren-free remainder, overlay the paren position.
    return withTitleSegmentSeriesParen(titleSegment, asinTail, identity, (remainder) =>
      parseTwoPartTitleSegment(parts[0]!, remainder, p8Author, p8Series, asinTail, identity));
  }

  const lastSegment = stripAudioExtension(parts[parts.length - 1]!);
  const { asin, cleaned } = extractASIN(lastSegment);
  const titleSegment = cleaned || lastSegment;
  const asinTail = asin !== undefined ? { asin } : {};
  const folderSeries = parts[parts.length - 2]!;
  // Trailing `(Series Book N)` paren — mirrors the cleaned 3+-part branch with `identity` (raw
  // series name is NOT run through cleanName). Folder series segment stays authoritative for the name.
  return withTitleSegmentSeriesParen(titleSegment, asinTail, identity, (remainder) => ({
    title: remainder,
    author: parts[0]!,
    series: folderSeries,
    ...asinTail,
  }));
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

  // P4: "Series, Book NN - Title" — raw substrings preserved.
  const seriesBookMatch = matchFirstDashOnly(input, SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) return seriesPosResult(seriesBookMatch, null, asinTail, identity);

  const titleDashSeries = tryTitleDashSeriesBook(input, asinTail, identity);
  if (titleDashSeries) return titleDashSeries;

  // P15: whole-input lowercase kebab-case → bail to title-only
  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  // P10-precheck (no-author path)
  const p10Pre = matchFirstDashOnly(input, WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre) return seriesPosResult(p10Pre, null, asinTail, identity);

  // #1271: "Book N of [the] <Series> Saga" descriptor — strip it and fix Title-first ordering.
  const bookOfSeries = tryBookOfSeriesDescriptor(input, asinTail, identity,
    (residual) => tryAuthorTitleForms(residual, asinTail, identity));
  if (bookOfSeries) return bookOfSeries;

  const authorTitle = tryAuthorTitleForms(input, asinTail, identity);
  if (authorTitle) return authorTitle;

  return { title: cleaned ? input : folder, author: null, series: null, ...asinTail };
}

/**
 * Extracts a 4-digit year (1900–2099) from a folder name string.
 * Checks parenthesized, bracketed, and bare trailing years.
 */
export function extractYear(name: string): number | undefined {
  const normalized = normalizeFolderName(name);
  // Check parenthesized year: (2017)
  const parenMatch = normalized.match(/\((\d{4})\)\s*$/);
  if (parenMatch) {
    const y = parseInt(parenMatch[1]!, 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  // Check bracketed year: [2017]
  const bracketMatch = normalized.match(/\[(\d{4})\]\s*$/);
  if (bracketMatch) {
    const y = parseInt(bracketMatch[1]!, 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  // Check bare trailing year
  const bareMatch = normalized.match(BARE_YEAR_REGEX);
  if (bareMatch) {
    const y = parseInt(bareMatch[1]!, 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  return undefined;
}
