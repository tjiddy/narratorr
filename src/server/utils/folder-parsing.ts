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
  // All-numeric segment inputs ('11-22-63', '11.22.63', '1.5') are date-like
  // titles. Return unchanged — every step downstream would corrupt them: the
  // leading-numeric strip eats the first segment, normalizeFolderName turns
  // dots into spaces, and the bare-year strip can drop a trailing 4-digit
  // segment. One early return covers all of these.
  if (isAllNumericSegments(name)) return name;

  // Strip leading number prefixes (track/series position):
  //   '01 - Title', '01. Title', '01.- Title', '6.5 - Title', '6.5 – Title'
  // Decimal positions checked first so '6.5' isn't split into '6.' + '5'.
  const stripped = name
    .replace(/^\d+\.\d+\s*[–-]\s*/, '')          // decimal + dash: '6.5 - ', '6.5 – '
    .replace(/^\d+[.\s]*[–-]\s*/, '')             // integer + dash: '01 - ', '01.- '
    .replace(/^\d+\.(?!\d)\s*/, '');              // integer + dot (not decimal): '01. '

  // Strip series markers (", Book 01", ", Vol 3", ", Volume 12") before dedup
  const withoutSeries = stripped.replace(SERIES_MARKER_REGEX, '');

  let result = normalizeFolderName(withoutSeries)
    .replace(/\s*\(\d{4}\)$/, '') // Remove trailing year like "(2020)"
    .replace(/\s*\[\d{4}\]$/, '') // Remove trailing year like "[2020]"
    .replace(BARE_YEAR_REGEX, '') // Remove bare trailing year like "2017"
    .replace(/\s*\(\s*\)/g, '')   // Remove empty parentheses (e.g. after codec strip)
    .replace(/\s*\[\s*\]/g, '')   // Remove empty brackets (e.g. after codec strip)
    .trim();

  // Strip trailing narrator-style parenthetical (1-3 word name, not codec/year)
  const narratorMatch = result.match(NARRATOR_PAREN_REGEX);
  if (narratorMatch) {
    const content = narratorMatch[1];
    // Don't strip if content is a known codec tag (already handled, but guard against edge cases)
    if (!CODEC_TEST_REGEX.test(content)) {
      const beforeParen = result.replace(NARRATOR_PAREN_REGEX, '').trim();
      if (beforeParen) result = beforeParen;
    }
  }

  // Deduplicate repeated title segments: "Title 01 – Title" → "Title"
  // Handles patterns like "Dungeon Crawler Carl 01 – Dungeon Crawler Carl"
  // and "The Hunger Games, Book 01 – The Hunger Games"
  const dashParts = result.split(/\s*[–-]\s*/);
  if (dashParts.length === 2) {
    const left = dashParts[0]
      .replace(SERIES_MARKER_REGEX, '')   // strip ", Book 01" etc. from left
      .replace(/\s*\d+\s*$/, '')          // strip trailing number like "01"
      .trim();
    const right = dashParts[1].trim();
    if (left.toLowerCase() === right.toLowerCase() && right) {
      result = right;
    }
  }

  // Fall back to original name when normalization strips everything
  return result || name.trim();
}

/**
 * Trace-mode cleanName: runs the same pipeline as cleanName() but records
 * intermediate output after each transformation step.
 * Guarantees trace stays in sync with cleanName() by sharing the same logic.
 */
export function cleanNameWithTrace(name: string): CleanNameTraceResult {
  // Mirror cleanName's all-numeric short-circuit: every step is a no-op so
  // consumers still see the full 10-step trace shape.
  if (isAllNumericSegments(name)) {
    const steps: CleanNameStep[] = [
      'leadingNumeric', 'seriesMarker', 'normalize',
      'yearParenStrip', 'yearBracketStrip', 'yearBareStrip',
      'emptyParenStrip', 'emptyBracketStrip', 'narratorParen', 'dedup',
    ].map(stepName => ({ name: stepName, output: name }));
    return { input: name, steps, result: name };
  }

  const steps: CleanNameStep[] = [];
  let current = name;

  // Step 1: leadingNumeric
  current = current
    .replace(/^\d+\.\d+\s*[–-]\s*/, '')
    .replace(/^\d+[.\s]*[–-]\s*/, '')
    .replace(/^\d+\.(?!\d)\s*/, '');
  steps.push({ name: 'leadingNumeric', output: current });

  // Step 2: seriesMarker
  current = current.replace(SERIES_MARKER_REGEX, '');
  steps.push({ name: 'seriesMarker', output: current });

  // Step 3: normalize
  current = normalizeFolderName(current);
  steps.push({ name: 'normalize', output: current });

  // Step 4: yearParenStrip
  current = current.replace(/\s*\(\d{4}\)$/, '');
  steps.push({ name: 'yearParenStrip', output: current });

  // Step 5: yearBracketStrip
  current = current.replace(/\s*\[\d{4}\]$/, '');
  steps.push({ name: 'yearBracketStrip', output: current });

  // Step 6: yearBareStrip
  current = current.replace(BARE_YEAR_REGEX, '');
  steps.push({ name: 'yearBareStrip', output: current });

  // Step 7: emptyParenStrip
  current = current.replace(/\s*\(\s*\)/g, '');
  steps.push({ name: 'emptyParenStrip', output: current });

  // Step 8: emptyBracketStrip
  current = current.replace(/\s*\[\s*\]/g, '');
  steps.push({ name: 'emptyBracketStrip', output: current });

  // Trim after bracket/paren removal (mirrors cleanName's .trim())
  current = current.trim();

  // Step 9: narratorParen
  const narratorMatch = current.match(NARRATOR_PAREN_REGEX);
  if (narratorMatch) {
    const content = narratorMatch[1];
    if (!CODEC_TEST_REGEX.test(content)) {
      const beforeParen = current.replace(NARRATOR_PAREN_REGEX, '').trim();
      if (beforeParen) current = beforeParen;
    }
  }
  steps.push({ name: 'narratorParen', output: current });

  // Step 10: dedup
  const dashParts = current.split(/\s*[–-]\s*/);
  if (dashParts.length === 2) {
    const left = dashParts[0]
      .replace(SERIES_MARKER_REGEX, '')
      .replace(/\s*\d+\s*$/, '')
      .trim();
    const right = dashParts[1].trim();
    if (left.toLowerCase() === right.toLowerCase() && right) {
      current = right;
    }
  }
  steps.push({ name: 'dedup', output: current });

  // Fall back to original name when normalization strips everything
  const result = current || name.trim();

  return { input: name, steps, result };
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
  asin?: string;
} {
  // Extract ASIN bracket before any other pattern matching
  const { asin, cleaned } = extractASIN(folder);
  // Use cleaned input for pattern matching; fall back to original if cleaned is empty
  const input = cleaned || folder;

  // Guard: all-numeric date-like inputs ('11-22-63', '1.5') are titles, not
  // Series–NN–Title — short-circuit before pattern matching.
  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, asin };
  }

  // Pattern: "Series – NN – Title" or "Series - NN - Title"
  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) {
    return {
      title: cleanName(seriesNumberMatch[2]),
      author: null,
      series: cleanName(seriesNumberMatch[1]),
      asin,
    };
  }

  // Pattern: "Author - Title" (skip if left side is just a number like "01 - Title")
  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch && !/^\d+$/.test(dashMatch[1].trim())) {
    return {
      title: cleanName(dashMatch[2]),
      author: cleanName(dashMatch[1]),
      series: null,
      asin,
    };
  }

  // Pattern: "Title (Author)" or "Title [Author]"
  const parenMatch = input.match(/^(.+?)\s*[([](.+?)[)\]]$/);
  if (parenMatch) {
    return {
      title: cleanName(parenMatch[1]),
      author: cleanName(parenMatch[2]),
      series: null,
      asin,
    };
  }

  // Pattern: "Title by Author" (word-boundary, not inside words like "Standby")
  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1].trim();
    const right = byMatch[2].trim();
    // Guard: left side must not be just numbers, right side must be non-empty
    if (right && !/^\d+$/.test(left)) {
      return {
        title: cleanName(left),
        author: cleanName(right),
        series: null,
        asin,
      };
    }
  }

  // Just a title — use original folder if cleaned was empty (ASIN-only input)
  return {
    title: cleaned ? cleanName(input) : cleanName(folder),
    author: null,
    series: null,
    asin,
  };
}

/**
 * Parses folder path segments into author/title/series structure.
 * Supports 1-part (single folder), 2-part (Author/Title), and 3+-part (Author/Series/Title) layouts.
 *
 * Patterns for single-folder parsing:
 * - Author - Title
 * - Title (Author)
 * - Title [Author]
 * - Title by Author
 * - Series – NN – Title
 * - Title only
 */
export function parseFolderStructure(parts: string[]): {
  title: string;
  author: string | null;
  series: string | null;
  asin?: string;
} {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  // Single folder: try to parse "Author - Title" or "Title (Author)"
  if (parts.length === 1) {
    const folder = parts[0];
    return parseSingleFolder(folder);
  }

  // Two folders: Author/Title (or Author/Series – NN – Title)
  // Extract ASIN from the title segment (2-part branch bypasses parseSingleFolder)
  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(parts[1]);
    const titleSegment = cleaned || parts[1];
    if (isAllNumericSegments(titleSegment)) {
      return {
        title: titleSegment,
        author: cleanName(parts[0]),
        series: null,
        asin,
      };
    }
    const seriesMatch = titleSegment.match(SERIES_NUMBER_TITLE_REGEX);
    if (seriesMatch) {
      return {
        title: cleanName(seriesMatch[2]),
        author: cleanName(parts[0]),
        series: cleanName(seriesMatch[1]),
        asin,
      };
    }
    return {
      title: cleanName(titleSegment),
      author: cleanName(parts[0]),
      series: null,
      asin,
    };
  }

  // Three or more folders: Author/Series/Title (take first, second-to-last, last)
  // Extract ASIN from the title segment (last part)
  const { asin, cleaned } = extractASIN(parts[parts.length - 1]);
  const titleSegment = cleaned || parts[parts.length - 1];
  return {
    title: cleanName(titleSegment),
    author: cleanName(parts[0]),
    series: cleanName(parts[parts.length - 2]),
    asin,
  };
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
  asin?: string;
} {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  if (parts.length === 1) {
    return parseSingleFolderRaw(parts[0]);
  }

  if (parts.length === 2) {
    const { asin, cleaned } = extractASIN(parts[1]);
    const titleSegment = cleaned || parts[1];
    if (isAllNumericSegments(titleSegment)) {
      return { title: titleSegment, author: parts[0], series: null, asin };
    }
    const seriesMatch = titleSegment.match(SERIES_NUMBER_TITLE_REGEX);
    if (seriesMatch) {
      return { title: seriesMatch[2], author: parts[0], series: seriesMatch[1], asin };
    }
    return { title: titleSegment, author: parts[0], series: null, asin };
  }

  const { asin, cleaned } = extractASIN(parts[parts.length - 1]);
  const titleSegment = cleaned || parts[parts.length - 1];
  return {
    title: titleSegment,
    author: parts[0],
    series: parts[parts.length - 2],
    asin,
  };
}

function parseSingleFolderRaw(folder: string): {
  title: string;
  author: string | null;
  series: string | null;
  asin?: string;
} {
  const { asin, cleaned } = extractASIN(folder);
  const input = cleaned || folder;

  if (isAllNumericSegments(input)) {
    return { title: input, author: null, series: null, asin };
  }

  const seriesNumberMatch = input.match(SERIES_NUMBER_TITLE_REGEX);
  if (seriesNumberMatch) {
    return { title: seriesNumberMatch[2], author: null, series: seriesNumberMatch[1], asin };
  }

  const dashMatch = input.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch && !/^\d+$/.test(dashMatch[1].trim())) {
    return { title: dashMatch[2], author: dashMatch[1], series: null, asin };
  }

  const parenMatch = input.match(/^(.+?)\s*[([](.+?)[)\]]$/);
  if (parenMatch) {
    return { title: parenMatch[1], author: parenMatch[2], series: null, asin };
  }

  const byMatch = input.match(/^(.+?)\bby\b(.+)$/i);
  if (byMatch) {
    const left = byMatch[1].trim();
    const right = byMatch[2].trim();
    if (right && !/^\d+$/.test(left)) {
      return { title: left, author: right, series: null, asin };
    }
  }

  return { title: cleaned ? input : folder, author: null, series: null, asin };
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
    const y = parseInt(parenMatch[1], 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  // Check bracketed year: [2017]
  const bracketMatch = normalized.match(/\[(\d{4})\]\s*$/);
  if (bracketMatch) {
    const y = parseInt(bracketMatch[1], 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  // Check bare trailing year
  const bareMatch = normalized.match(BARE_YEAR_REGEX);
  if (bareMatch) {
    const y = parseInt(bareMatch[1], 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  return undefined;
}
