// ─── Folder Parsing & Cleaning ──────────────────────────────────────
// Extracted from library-scan.service.ts for shared use by scan and debug endpoints.
// All functions are pure (no `this`, no I/O).

// ─── Regex Constants ────────────────────────────────────────────────

/** Codec/format tags to strip from folder names (case-insensitive, word-boundary). */
const CODEC_TAGS = ['MP3', 'M4B', 'M4A', 'FLAC', 'OGG', 'AAC', 'Unabridged', 'Abridged'];
const CODEC_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'gi');
/** Non-global codec regex for `.test()` guards — no `lastIndex` state between calls. */
export const CODEC_TEST_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'i');

/** Matches a bare 4-digit year (1900–2099) at end of string. */
const BARE_YEAR_REGEX = /\b((?:19|20)\d{2})\s*$/;

/** Matches "Series – NN – Title" or "Series - NN - Title" (dash or en-dash separators). */
const SERIES_NUMBER_TITLE_REGEX = /^(.+?)\s*[–-]\s*\d+\s*[–-]\s*(.+)$/;

/** Matches trailing ", Book NN", ", Vol NN", ", Volume NN" series markers. */
const SERIES_MARKER_REGEX = /,\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

/**
 * Matches trailing parenthetical containing a person's name (1-3 words).
 * Does NOT match: years (2020), codec tags (handled by CODEC_REGEX), or long subtitles (>3 words).
 */
const NARRATOR_PAREN_REGEX = /\s*\((?!(?:19|20)\d{2}\))(\S+(?:\s+\S+){0,2})\)\s*$/;

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

function isEditionParen(content: string): boolean {
  return EDITION_PAREN_YEAR_PREFIX.test(content)
    || EDITION_PAREN_ORDINAL_PREFIX.test(content)
    || EDITION_PAREN_KEYWORD.test(content);
}

/** P4: `Series, Book NN - Title` — only fires when the left of the first ` - ` ends with `, Book NN`. */
const SERIES_BOOK_DASH_TITLE_REGEX = /^(.+?),\s*book\s+(\d+)\s*-\s*(.+)$/i;

/** P15: whole input is lowercase kebab-case (letters + hyphens only, 2+ segments). */
const KEBAB_CASE_REGEX = /^[a-z]+(?:-[a-z]+)+$/;

/** P10: `<words> NN - <subtitle>` — used for both precheck (before dash heuristic) and postprocess (on resolved title). */
const WORDS_NUM_DASH_TITLE_REGEX = /^(.+?)\s+(\d+)\s*-\s*(.+)$/;

/** P9: `Last, First` author convention — exactly two name-shaped tokens around a comma. */
const LAST_FIRST_AUTHOR_REGEX = /^([\w'.-]+),\s*([\w'.-]+)$/;

/** Apply P9 swap: `Last, First` → `First Last`. No-op if pattern doesn't match. */
function applyLastFirstSwap(author: string): string {
  const match = author.match(LAST_FIRST_AUTHOR_REGEX);
  if (match) return `${match[2]} ${match[1]}`;
  return author;
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
  ['bracketTagStrip', s => s.replace(/\s*\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim()],
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

function parseSingleFolder(folder: string): {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
} {
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

  // Pattern: "Series – NN – Title" or "Series - NN - Title"
  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) {
    return {
      title: cleanName(seriesNumberMatch[2]!),
      author: null,
      series: cleanName(seriesNumberMatch[1]!),
      ...asinTail,
    };
  }

  // P4: "Series, Book NN - Title" — left of first ` - ` ends with `, Book NN`
  const seriesBookMatch = input.match(SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) {
    return {
      title: cleanName(seriesBookMatch[3]!),
      author: null,
      series: cleanName(seriesBookMatch[1]!),
      seriesPosition: parseInt(seriesBookMatch[2]!, 10),
      ...asinTail,
    };
  }

  // P15: whole-input lowercase kebab-case → bail to title-only
  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: cleanName(input), author: null, series: null, ...asinTail };
  }

  // P10-precheck (no-author path): "<series> NN - <title>" with no ` - ` in series
  const p10Pre = input.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre && !p10Pre[1]!.includes(' - ')) {
    return {
      title: cleanName(p10Pre[3]!),
      author: null,
      series: cleanName(p10Pre[1]!),
      seriesPosition: parseInt(p10Pre[2]!, 10),
      ...asinTail,
    };
  }

  // Pattern: "Author - Title" (skip if left side is just a number like "01 - Title")
  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch && !/^\d+$/.test(dashMatch[1]!.trim())) {
    const author = applyLastFirstSwap(cleanName(dashMatch[1]!));
    const title = cleanName(dashMatch[2]!);
    return applyP10Postprocess(title, author, asinTail);
  }

  // Pattern: "Title by Author" (word-boundary, not inside words like "Standby")
  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1]!.trim();
    const right = byMatch[2]!.trim();
    // Guard: left side must not be just numbers, right side must be non-empty
    if (right && !/^\d+$/.test(left)) {
      const author = applyLastFirstSwap(cleanName(right));
      const title = cleanName(left);
      return applyP10Postprocess(title, author, asinTail);
    }
  }

  // Just a title — use original folder if cleaned was empty (ASIN-only input)
  return {
    title: cleaned ? cleanName(input) : cleanName(folder),
    author: null,
    series: null,
    ...asinTail,
  };
}

/**
 * P10-postprocess (author-dash path): if a resolved title still looks like
 * `<series> NN - <subtitle>`, decompose it. Preserves the already-resolved author.
 */
function applyP10Postprocess(
  title: string,
  author: string,
  asinTail: { asin?: string },
): { title: string; author: string | null; series: string | null; seriesPosition?: number; asin?: string } {
  const match = title.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (match) {
    return {
      title: cleanName(match[3]!),
      author,
      series: cleanName(match[1]!),
      seriesPosition: parseInt(match[2]!, 10),
      ...asinTail,
    };
  }
  return { title, author, series: null, ...asinTail };
}

/** Raw variant of P10-postprocess — no cleanName applied. */
function applyP10PostprocessRaw(
  title: string,
  author: string,
  asinTail: { asin?: string },
): { title: string; author: string | null; series: string | null; seriesPosition?: number; asin?: string } {
  const match = title.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (match) {
    return {
      title: match[3]!,
      author,
      series: match[1]!,
      seriesPosition: parseInt(match[2]!, 10),
      ...asinTail,
    };
  }
  return { title, author, series: null, ...asinTail };
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
export function parseFolderStructure(parts: string[]): {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
} {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  // Single folder: try to parse "Author - Title" or other patterns
  if (parts.length === 1) {
    const folder = parts[0]!;
    return parseSingleFolder(folder);
  }

  // Two folders: Author/Title (or Author/Series – NN – Title)
  // Extract ASIN from the title segment (2-part branch bypasses parseSingleFolder)
  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(parts[1]!);
    const titleSegment = cleaned || parts[1]!;

    // P8: detect "Author - Series" in author segment (ASCII hyphen only)
    const { author: p8Author, series: p8Series } = splitAuthorSegment(parts[0]!);

    if (isAllNumericSegments(titleSegment)) {
      return {
        title: titleSegment,
        author: p8Author,
        series: p8Series,
        ...(asin !== undefined && { asin }),
      };
    }
    const seriesMatch = titleSegment.match(SERIES_NUMBER_TITLE_REGEX);
    if (seriesMatch) {
      return {
        title: cleanName(seriesMatch[2]!),
        author: p8Author,
        // SERIES_NUMBER_TITLE in title segment wins over P8's series-from-author
        series: cleanName(seriesMatch[1]!),
        ...(asin !== undefined && { asin }),
      };
    }
    return {
      title: cleanName(titleSegment),
      author: p8Author,
      series: p8Series,
      ...(asin !== undefined && { asin }),
    };
  }

  // Three or more folders: Author/Series/Title (take first, second-to-last, last)
  // Extract ASIN from the title segment (last part)
  const { asin, cleaned } = extractASIN(parts[parts.length - 1]!);
  const titleSegment = cleaned || parts[parts.length - 1]!;
  return {
    title: cleanName(titleSegment),
    author: cleanName(parts[0]!),
    series: cleanName(parts[parts.length - 2]!),
    ...(asin !== undefined && { asin }),
  };
}

/**
 * P8: split a 2-part `Author - Series` first segment into separate fields.
 * Falls back to whole-segment author when there's no ASCII ` - ` to split on
 * or the recursive parse can't resolve an author.
 */
function splitAuthorSegment(segment: string): { author: string; series: string | null } {
  if (!segment.includes(' - ')) {
    return { author: cleanName(segment), series: null };
  }
  const sub = parseSingleFolder(segment);
  if (sub.author && sub.title) {
    return { author: sub.author, series: sub.title };
  }
  return { author: cleanName(segment), series: null };
}

function splitAuthorSegmentRaw(segment: string): { author: string; series: string | null } {
  if (!segment.includes(' - ')) {
    return { author: segment, series: null };
  }
  const sub = parseSingleFolderRaw(segment);
  if (sub.author && sub.title) {
    return { author: sub.author, series: sub.title };
  }
  return { author: segment, series: null };
}

/**
 * Like parseFolderStructure, but returns the raw (pre-cleanName) values.
 * Used by the scan-debug endpoint to build cleaning traces from the actual
 * raw segments rather than the already-cleaned parser output.
 */
export function parseFolderStructureRaw(parts: string[]): {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
} {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  if (parts.length === 1) {
    return parseSingleFolderRaw(parts[0]!);
  }

  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(parts[1]!);
    const titleSegment = cleaned || parts[1]!;

    // P8: split `Author - Series` from raw author segment
    const { author: p8Author, series: p8Series } = splitAuthorSegmentRaw(parts[0]!);

    if (isAllNumericSegments(titleSegment)) {
      return { title: titleSegment, author: p8Author, series: p8Series, ...(asin !== undefined && { asin }) };
    }
    const seriesMatch = titleSegment.match(SERIES_NUMBER_TITLE_REGEX);
    if (seriesMatch) {
      return { title: seriesMatch[2]!, author: p8Author, series: seriesMatch[1]!, ...(asin !== undefined && { asin }) };
    }
    return { title: titleSegment, author: p8Author, series: p8Series, ...(asin !== undefined && { asin }) };
  }

  const { asin, cleaned } = extractASIN(parts[parts.length - 1]!);
  const titleSegment = cleaned || parts[parts.length - 1]!;
  return {
    title: titleSegment,
    author: parts[0]!,
    series: parts[parts.length - 2]!,
    ...(asin !== undefined && { asin }),
  };
}

function parseSingleFolderRaw(folder: string): {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition?: number;
  asin?: string;
} {
  const { asin, cleaned } = extractASIN(folder);
  const input = cleaned || folder;
  const asinTail = asin !== undefined ? { asin } : {};

  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) {
    return { title: seriesNumberMatch[2]!, author: null, series: seriesNumberMatch[1]!, ...asinTail };
  }

  // P4: "Series, Book NN - Title" — raw substrings preserved
  const seriesBookMatch = input.match(SERIES_BOOK_DASH_TITLE_REGEX);
  if (seriesBookMatch) {
    return {
      title: seriesBookMatch[3]!,
      author: null,
      series: seriesBookMatch[1]!,
      seriesPosition: parseInt(seriesBookMatch[2]!, 10),
      ...asinTail,
    };
  }

  // P15: whole-input lowercase kebab-case → bail to title-only
  if (KEBAB_CASE_REGEX.test(input)) {
    return { title: input, author: null, series: null, ...asinTail };
  }

  // P10-precheck (no-author path)
  const p10Pre = input.match(WORDS_NUM_DASH_TITLE_REGEX);
  if (p10Pre && !p10Pre[1]!.includes(' - ')) {
    return {
      title: p10Pre[3]!,
      author: null,
      series: p10Pre[1]!,
      seriesPosition: parseInt(p10Pre[2]!, 10),
      ...asinTail,
    };
  }

  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch && !/^\d+$/.test(dashMatch[1]!.trim())) {
    const author = applyLastFirstSwap(dashMatch[1]!);
    return applyP10PostprocessRaw(dashMatch[2]!, author, asinTail);
  }

  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1]!.trim();
    const right = byMatch[2]!.trim();
    if (right && !/^\d+$/.test(left)) {
      const author = applyLastFirstSwap(right);
      return applyP10PostprocessRaw(left, author, asinTail);
    }
  }

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
