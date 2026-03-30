import type { NamingSeparator, NamingCase } from '../../shared/schemas/settings/library.js';

/** Token grammar: `{name}`, `{name:digits}`, `{name?text}`, or `{name:digits?text}`. */
export const TOKEN_PATTERN_SOURCE = String.raw`\{(\w+)(?::(\d+))?(?:\?([^}]*))?\}`;

export interface NamingOptions {
  separator?: NamingSeparator;
  case?: NamingCase;
}

/** Convert library settings shape to NamingOptions. */
export function toNamingOptions(settings: { namingSeparator: NamingSeparator; namingCase: NamingCase }): NamingOptions {
  return { separator: settings.namingSeparator, case: settings.namingCase };
}

const SEPARATOR_CHARS: Record<NamingSeparator, string> = {
  space: ' ',
  period: '.',
  underscore: '_',
  dash: '-',
};

const CASE_TRANSFORMS: Record<NamingCase, (s: string) => string> = {
  default: (s) => s,
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  title: (s) => s.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
};

/** Apply separator and case transforms to a resolved token value. */
function applyTokenTransforms(value: string, options?: NamingOptions): string {
  // Case transform first (operates on original spacing)
  let result = CASE_TRANSFORMS[options?.case ?? 'default'](value);

  // Separator transform
  const sep = options?.separator ?? 'space';
  if (sep !== 'space') {
    // Collapse ", " → "," before replacing spaces (handles "Last, First" format)
    result = result.replace(/, /g, ',');
    const sepChar = SEPARATOR_CHARS[sep];
    result = result.replace(/ /g, sepChar);
    // Collapse consecutive separator characters
    const escaped = sepChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`${escaped}{2,}`, 'g'), sepChar);
    // Trim leading/trailing separator characters
    result = result.replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), '');
  }

  return result;
}

/** Check if a numeric token value should skip separator/case transforms. */
function isNumericFormatted(padSpec: string | undefined, raw: string | number | undefined | null): boolean {
  return padSpec !== undefined && raw !== undefined && raw !== null && !isNaN(Number(raw));
}

/** Allowed token names for folder naming templates. */
export const FOLDER_ALLOWED_TOKENS = [
  'author', 'authorLastFirst',
  'title', 'titleSort',
  'series', 'seriesPosition',
  'year',
  'narrator', 'narratorLastFirst',
] as const;

/** Backward-compatible alias. */
export const ALLOWED_TOKENS = FOLDER_ALLOWED_TOKENS;

/** File-specific tokens (trackNumber, trackTotal, partName) plus all folder tokens. */
export const FILE_ALLOWED_TOKENS = [
  ...FOLDER_ALLOWED_TOKENS,
  'trackNumber', 'trackTotal', 'partName',
] as const;

export type TokenName = (typeof FOLDER_ALLOWED_TOKENS)[number];
export type FileTokenName = (typeof FILE_ALLOWED_TOKENS)[number];

/** Leading articles stripped for sort titles (English). */
const SORT_ARTICLES = /^(?:the|a|an)\s+/i;

/**
 * Flip a name from "First Last" to "Last, First".
 * Handles multi-name values separated by commas or ampersands:
 *   "Brandon Sanderson & Robert Jordan" → "Sanderson, Brandon & Jordan, Robert"
 * Already "Last, First" names (detected by comma) pass through unchanged.
 */
export function toLastFirst(name: string): string {
  if (!name.trim()) return name;

  // First try splitting on & or "and"
  const ampParts = name.split(/\s*(?:&|\band\b)\s*/);
  if (ampParts.length > 1) {
    return ampParts.map((p) => flipSingleName(p.trim())).join(' & ');
  }

  // Try comma-separated: "Michael Kramer, Kate Reading"
  // If all parts are multi-word, treat as separate people in "First Last" format
  const commaParts = name.split(/,\s*/);
  if (commaParts.length > 1 && commaParts.every((p) => p.trim().split(/\s+/).length >= 2)) {
    return commaParts.map((p) => flipSingleName(p.trim())).join(' & ');
  }

  // Single name or already "Last, First"
  return flipSingleName(name.trim());
}

/** Flip a single "First Last" → "Last, First". Already-flipped names pass through. */
function flipSingleName(name: string): string {
  // Already in "Last, First" format
  if (name.includes(',')) return name;

  const words = name.split(/\s+/);
  if (words.length <= 1) return name;

  const last = words.pop()!;
  return `${last}, ${words.join(' ')}`;
}

/** Strip leading articles for sort-friendly titles. */
export function toSortTitle(title: string): string {
  return title.replace(SORT_ARTICLES, '').trim() || title;
}

/** Characters illegal on Windows/Linux/macOS filesystems. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Max length for a single path segment (filesystem limit). */
const MAX_SEGMENT_LENGTH = 255;

/** Sanitize a string for use as a filesystem path segment. */
export function sanitizePath(segment: string): string {
  let result = segment
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s{2,}/g, ' ') // collapse consecutive spaces
    .replace(/\.+$/, '') // trailing dots (Windows)
    .trim();

  // Truncate to filesystem limit
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = result.slice(0, MAX_SEGMENT_LENGTH).trim();
  }

  return result || 'Unknown';
}

/** Resolve tokens in a template string — shared logic for renderTemplate/renderFilename. */
function resolveTokens(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
): string {
  return template.replace(
    new RegExp(TOKEN_PATTERN_SOURCE, 'g'),
    (_match, name: string, padSpec: string | undefined, conditional: string | undefined) => {
      const raw = tokens[name];
      const hasValue = raw !== undefined && raw !== null && raw !== '';

      if (!hasValue) {
        return '';
      }

      let value = String(raw);

      // Format specifier: {seriesPosition:00} → zero-pad
      if (padSpec) {
        const num = Number(value);
        if (!isNaN(num)) {
          value = String(num).padStart(padSpec.length, '0');
        }
      }

      // Apply separator/case transforms to non-numeric token values
      if (!isNumericFormatted(padSpec, raw)) {
        value = applyTokenTransforms(value, options);
      }

      // Conditional block: {token:00?text} or {token?text} — append text only if token has value
      if (conditional !== undefined) {
        return value + conditional;
      }

      return value;
    },
  );
}

/**
 * Render a naming template with token values.
 *
 * Supports:
 * - `{token}` — simple replacement
 * - `{token?text}` — conditional: renders `text` only if token has a value
 * - `{token:00}` — zero-pad format specifier (digit count = specifier length)
 */
export function renderTemplate(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
): string {
  const rendered = resolveTokens(template, tokens, options);

  // Split by /, sanitize non-empty segments, filter empties
  return rendered
    .split('/')
    .map((seg) => seg.trim())
    .filter((s) => s.length > 0)
    .map((s) => sanitizePath(s))
    .join('/');
}

/**
 * Render a filename template with token values.
 *
 * Unlike `renderTemplate()`, this does NOT split on `/` — the result is
 * sanitized as a single filename segment. The caller is responsible for
 * appending the file extension.
 */
export function renderFilename(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
): string {
  const rendered = resolveTokens(template, tokens, options);
  return sanitizePath(rendered);
}

export interface TemplateParseResult {
  /** Token names found in the template. */
  tokens: string[];
  /** Errors that must be fixed. */
  errors: string[];
  /** Warnings (non-blocking). */
  warnings: string[];
}

/**
 * Parse and validate a naming template.
 *
 * Returns found tokens, errors (e.g. missing {title}, unknown tokens),
 * and warnings (e.g. missing {author}).
 *
 * @param allowedTokens — override the allowed token list (defaults to FOLDER_ALLOWED_TOKENS)
 */
export function parseTemplate(
  template: string,
  allowedTokens: readonly string[] = FOLDER_ALLOWED_TOKENS,
): TemplateParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens: string[] = [];
  const allowedSet = new Set<string>(allowedTokens);

  // Extract all token names from {token}, {token:spec}, {token?text}
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    const name = match[1];
    if (!tokens.includes(name)) {
      tokens.push(name);
    }
    if (!allowedSet.has(name)) {
      errors.push(`Unknown token: {${name}}`);
    }
  }

  if (!tokens.includes('title') && !tokens.includes('titleSort')) {
    errors.push('Template must include {title} or {titleSort}');
  }

  if (!tokens.includes('author') && !tokens.includes('authorLastFirst')) {
    warnings.push('Consider including {author} or {authorLastFirst} for better organization');
  }

  return { tokens, errors, warnings };
}

/** Token display groups for the naming token modal. */
export interface TokenGroup {
  label: string;
  tokens: readonly string[];
}

export const FOLDER_TOKEN_GROUPS: readonly TokenGroup[] = [
  { label: 'Author', tokens: ['author', 'authorLastFirst'] },
  { label: 'Title', tokens: ['title', 'titleSort'] },
  { label: 'Series', tokens: ['series', 'seriesPosition'] },
  { label: 'Narrator', tokens: ['narrator', 'narratorLastFirst'] },
  { label: 'Metadata', tokens: ['year'] },
];

export const FILE_ONLY_TOKEN_GROUP: TokenGroup = {
  label: 'File-specific',
  tokens: ['trackNumber', 'trackTotal', 'partName'],
};
