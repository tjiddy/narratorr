import type { NamingSeparator, NamingCase } from '../../shared/schemas/settings/library.js';

/**
 * Token grammar:
 * - `{name}` — simple replacement
 * - `{name:digits}` — zero-padded
 * - `{name?text}` — conditional suffix
 * - `{name:digits?text}` — padded + suffix
 * - `{text?name}` — conditional prefix (when text is not a known token)
 * - `{text?name:digits}` — prefix + padded
 * - `{text?name?text}` — prefix + suffix
 *
 * Disambiguation: suffix-first precedence. See `disambiguateTokenMatch()`.
 * Groups: (1) optional prefix, (2) token candidate, (3) pad spec, (4) optional suffix.
 */
export const TOKEN_PATTERN_SOURCE = String.raw`\{(?:([^}?]*?)\?)?(\w+)(?::(\d+))?(?:\?([^}]*))?\}`;

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

/**
 * Suffix-first disambiguation for the token regex.
 *
 * The regex captures: (1) optional prefix text, (2) \w+ candidate, (3) pad, (4) suffix.
 * For `{author?title}`, group 1="author", group 2="title".
 * For `{ - pt?trackNumber:00}`, group 1=" - pt", group 2="trackNumber".
 *
 * Rule: extract the first `\w+` from group 1. If it IS a known token → re-interpret
 * as suffix syntax (group 1's word is the real token, everything after `?` is suffix).
 * If NOT known → keep as prefix syntax.
 */
function disambiguateTokenMatch(
  candidatePrefix: string | undefined,
  candidateName: string,
  padSpec: string | undefined,
  candidateSuffix: string | undefined,
  allowedTokens: ReadonlySet<string>,
): { prefix: string | undefined; name: string; padSpec: string | undefined; suffix: string | undefined } {
  if (!candidatePrefix) {
    // No prefix group → simple token or suffix-only syntax
    return { prefix: undefined, name: candidateName, padSpec, suffix: candidateSuffix };
  }

  // Extract first \w+ from the candidate prefix
  const firstWordMatch = candidatePrefix.match(/\w+/);
  if (firstWordMatch && allowedTokens.has(firstWordMatch[0])) {
    // The first word is a known token → re-interpret as suffix syntax
    // The real token is the first word; everything after ? is suffix text
    const realToken = firstWordMatch[0];
    // Reconstruct the suffix: candidateName + (padSpec if any) + (candidateSuffix if any)
    let reconstructedSuffix = candidateName;
    if (padSpec !== undefined) {
      reconstructedSuffix += ':' + padSpec;
    }
    if (candidateSuffix !== undefined) {
      reconstructedSuffix += '?' + candidateSuffix;
    }
    // The original candidatePrefix may have had text before the token word — that was literal text
    // But the regex `([^}?]*?)\?` captures greedily up to the first `?`, so the prefix IS the full first word
    // Extract padSpec from original prefix if present (e.g., {author:00?title} — unlikely but possible)
    // For suffix reinterpretation, there's no pad spec from the prefix — the original token format was {name?suffix}
    return { prefix: undefined, name: realToken, padSpec: undefined, suffix: reconstructedSuffix };
  }

  // First word is NOT a known token → keep as prefix syntax
  return { prefix: candidatePrefix, name: candidateName, padSpec, suffix: candidateSuffix };
}

/** Build a set of all known token names for disambiguation. */
const ALL_KNOWN_TOKENS = new Set<string>([...FILE_ALLOWED_TOKENS]);

/** Resolve tokens in a template string — shared logic for renderTemplate/renderFilename. */
function resolveTokens(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
): string {
  return template.replace(
    new RegExp(TOKEN_PATTERN_SOURCE, 'g'),
    (_match, candidatePrefix: string | undefined, candidateName: string, rawPadSpec: string | undefined, candidateSuffix: string | undefined) => {
      const { prefix, name, padSpec, suffix } = disambiguateTokenMatch(
        candidatePrefix, candidateName, rawPadSpec, candidateSuffix, ALL_KNOWN_TOKENS,
      );

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

      // Build result: prefix + value + suffix
      let result = value;
      if (prefix !== undefined) {
        result = prefix + result;
      }
      if (suffix !== undefined) {
        result = result + suffix;
      }

      return result;
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

  // Extract all token names from {token}, {token:spec}, {token?text}, {prefix?token}
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    const { name } = disambiguateTokenMatch(
      match[1], match[2], match[3], match[4], allowedSet,
    );
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
