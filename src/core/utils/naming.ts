import {
  type NamingSeparator,
  type NamingCase,
  FOLDER_ALLOWED_TOKENS,
  FILE_ALLOWED_TOKENS,
  TOKEN_PATTERN_SOURCE,
} from '@shared/naming-constants.js';
import { IMPORT_SIBLING_SUFFIXES } from './import-sibling-suffixes.js';

export {
  TOKEN_PATTERN_SOURCE,
  FOLDER_ALLOWED_TOKENS,
  FILE_ALLOWED_TOKENS,
  type NamingSeparator,
  type NamingCase,
};

export interface NamingOptions {
  separator?: NamingSeparator;
  case?: NamingCase;
}

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

function applyTokenTransforms(value: string, options?: NamingOptions): string {
  // Case transforms run while the original word spacing still exists.
  let result = CASE_TRANSFORMS[options?.case ?? 'default'](value);

  const sep = options?.separator ?? 'space';
  if (sep !== 'space') {
    // Collapse ", " → "," before replacing spaces (handles "Last, First" format)
    result = result.replace(/, /g, ',');
    const sepChar = SEPARATOR_CHARS[sep];
    result = result.replace(/ /g, sepChar);
    const escaped = sepChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`${escaped}{2,}`, 'g'), sepChar);
    result = result.replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), '');
  }

  return result;
}

function isNumericFormatted(padSpec: string | undefined, raw: string | number | undefined | null): boolean {
  return padSpec !== undefined && raw !== undefined && raw !== null && !isNaN(Number(raw));
}

export type TokenName = (typeof FOLDER_ALLOWED_TOKENS)[number];
export type FileTokenName = (typeof FILE_ALLOWED_TOKENS)[number];

const SORT_ARTICLES = /^(?:the|a|an)\s+/i;

/**
 * Flips one or more `First Last` names to `Last, First`. Ampersand/`and` always separates
 * people; comma-separated multiword parts do too. Existing single `Last, First` names pass through.
 */
export function toLastFirst(name: string): string {
  if (!name.trim()) return name;

  const ampParts = name.split(/\s*(?:&|\band\b)\s*/);
  if (ampParts.length > 1) {
    return ampParts.map((p) => flipSingleName(p.trim())).join(' & ');
  }

  // Multiple multiword comma parts are people, not an already-flipped single name.
  const commaParts = name.split(/,\s*/);
  if (commaParts.length > 1 && commaParts.every((p) => p.trim().split(/\s+/).length >= 2)) {
    return commaParts.map((p) => flipSingleName(p.trim())).join(' & ');
  }

  return flipSingleName(name.trim());
}

function flipSingleName(name: string): string {
  if (name.includes(',')) return name;

  const words = name.split(/\s+/);
  if (words.length <= 1) return name;

  const last = words.pop()!;
  return `${last}, ${words.join(' ')}`;
}

export function toSortTitle(title: string): string {
  return title.replace(SORT_ARTICLES, '').trim() || title;
}

/** Characters illegal on Windows/Linux/macOS filesystems. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Max length for a single path segment (filesystem limit). */
const MAX_SEGMENT_LENGTH = 255;

/**
 * Removes repeated reserved import-sibling suffixes from segment ends, preventing scan exclusion
 * and marker collisions. Re-trims exposed dots/spaces after each case-sensitive removal.
 */
function stripReservedSuffixes(segment: string): string {
  let result = segment;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of IMPORT_SIBLING_SUFFIXES) {
      if (result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length).replace(/[\s.]+$/, '');
        stripped = true;
      }
    }
  }
  return result;
}

export function sanitizePath(segment: string): string {
  let result = segment
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.+$/, '')
    .trim();

  // Truncation can create a reserved ending, so suffix stripping must be the final pass.
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = result.slice(0, MAX_SEGMENT_LENGTH).trim();
  }

  result = stripReservedSuffixes(result);

  return result || 'Unknown';
}

/** Filesystem segment limit exposed for folder builders' leaf budgeting. */
export const PATH_SEGMENT_LIMIT = MAX_SEGMENT_LENGTH;

/**
 * Shared edition-label sanitizer for the in-place token and mandatory suffix paths. It applies the
 * same illegal-character, length, and reserved-suffix rules as `sanitizePath`, but returns `null`
 * rather than `Unknown` when no discriminator remains so callers preserve the base path.
 */
export function sanitizeEditionDiscriminator(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let result = raw
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.+$/, '')
    .trim();
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = result.slice(0, MAX_SEGMENT_LENGTH).trim();
  }
  result = stripReservedSuffixes(result);
  return result.length > 0 ? result : null;
}

/**
 * Composes `base (discriminator)` while preserving the already-sanitized discriminator verbatim.
 * The base is truncated first; only an over-limit discriminator is shortened, never to empty.
 * Reserved import suffixes are checked again on the composed leaf.
 */
export function composeEditionSuffixLeaf(base: string, discriminator: string): string {
  const suffix = ` (${discriminator})`;
  const budget = MAX_SEGMENT_LENGTH - suffix.length;
  let leaf: string;
  if (budget <= 0) {
    // Drop the base before shortening the discriminator; preserve at least one discriminator character.
    const discBudget = Math.max(1, MAX_SEGMENT_LENGTH - 2); // reserve the bare "()" wrapper
    const trimmedDisc = discriminator.length > discBudget ? discriminator.slice(0, discBudget).trim() : discriminator;
    leaf = `(${trimmedDisc})`;
  } else {
    const trimmedBase = base.length > budget ? base.slice(0, budget).trim() : base;
    leaf = `${trimmedBase}${suffix}`;
  }
  return stripReservedSuffixes(leaf) || leaf;
}

/**
 * Resolves the token regex's ambiguity: `{author?title}` initially looks like a prefix plus
 * `title`, while `{ - pt?trackNumber:00}` is a true prefix. A known token in the prefix is
 * reinterpreted as suffix syntax; unknown prefix text remains prefix syntax.
 */
function disambiguateTokenMatch(
  candidatePrefix: string | undefined,
  candidateName: string,
  padSpec: string | undefined,
  candidateSuffix: string | undefined,
  allowedTokens: ReadonlySet<string>,
): { prefix: string | undefined; name: string; padSpec: string | undefined; suffix: string | undefined } {
  if (!candidatePrefix) {
    return { prefix: undefined, name: candidateName, padSpec, suffix: candidateSuffix };
  }

  const firstWordMatch = candidatePrefix.match(/\w+/);
  if (firstWordMatch && allowedTokens.has(firstWordMatch[0])) {
    const realToken = firstWordMatch[0];
    // Reconstruct the suffix because the regex parsed everything after `?` as token syntax.
    let reconstructedSuffix = candidateName;
    if (padSpec !== undefined) {
      reconstructedSuffix += ':' + padSpec;
    }
    if (candidateSuffix !== undefined) {
      reconstructedSuffix += '?' + candidateSuffix;
    }
    return { prefix: undefined, name: realToken, padSpec: undefined, suffix: reconstructedSuffix };
  }

  return { prefix: candidatePrefix, name: candidateName, padSpec, suffix: candidateSuffix };
}

const ALL_KNOWN_TOKENS = new Set<string>([...FILE_ALLOWED_TOKENS]);

function resolveTokens(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
  verbatimTokens?: ReadonlySet<string>,
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
        return EMPTY_TOKEN_SENTINEL;
      }

      let value = String(raw);

      if (padSpec) {
        const num = Number(value);
        if (!isNaN(num)) {
          value = String(num).padStart(padSpec.length, '0');
        }
      }

      if (!isNumericFormatted(padSpec, raw) && !verbatimTokens?.has(name)) {
        value = applyTokenTransforms(value, options);
      }

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
 * Folder editions bypass styling so token and suffix branches produce the same discriminator.
 * Filename editions remain stylable.
 */
const FOLDER_VERBATIM_TOKENS: ReadonlySet<string> = new Set(['edition']);

/** Zero-width sentinel emitted by resolveTokens for empty/undefined token values. */
const EMPTY_TOKEN_SENTINEL = '\u200B';
const SENTINEL_REGEX = new RegExp(EMPTY_TOKEN_SENTINEL, 'g');

/**
 * Strip matched wrapper pairs (parentheses, brackets) that contain only empty-token
 * sentinels and whitespace. Literal empty wrappers (not from tokens) are preserved.
 */
function stripEmptyWrappers(text: string): string {
  const wrapperPattern = /\(\s*\u200B[\s\u200B]*\)|\[\s*\u200B[\s\u200B]*\]/g;
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(wrapperPattern, '');
  } while (result !== prev);
  result = result.replace(SENTINEL_REGEX, '');
  return result.replace(/ {2,}/g, ' ').trim();
}

/**
 * Render a naming template with token values.
 *
 * Supports:
 * - `{token}` — simple replacement
 * - `{token?suffix}` / `{prefix?token}` — conditional affixes
 * - `{token:00}` — zero-pad format specifier (digit count = specifier length)
 */
export function renderTemplate(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
  options?: NamingOptions,
): string {
  const rendered = stripEmptyWrappers(resolveTokens(template, tokens, options, FOLDER_VERBATIM_TOKENS));

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
  const rendered = stripEmptyWrappers(resolveTokens(template, tokens, options));
  return sanitizePath(rendered);
}

export interface TemplateParseResult {
  tokens: string[];
  errors: string[];
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

  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    const { name } = disambiguateTokenMatch(
      match[1], match[2]!, match[3], match[4], allowedSet,
    );
    if (!tokens.includes(name)) {
      tokens.push(name);
    }
    if (!allowedSet.has(name)) {
      errors.push(`Unknown token: {${name}}`);
    }
  }

  if (template && !tokens.includes('title') && !tokens.includes('titleSort')) {
    errors.push('Template must include {title} or {titleSort}');
  }

  if (template && !tokens.includes('author') && !tokens.includes('authorLastFirst')) {
    warnings.push('Consider including {author} or {authorLastFirst} for better organization');
  }

  return { tokens, errors, warnings };
}

/**
 * Uses suffix-first disambiguation to detect in-place edition rendering. Target builders must
 * suppress the mandatory collision suffix when the template already contains the token.
 */
export function templateHasToken(template: string, token: string): boolean {
  return parseTemplate(template, FILE_ALLOWED_TOKENS).tokens.includes(token);
}

export interface TokenGroup {
  label: string;
  tokens: readonly string[];
}

export const FOLDER_TOKEN_GROUPS: readonly TokenGroup[] = [
  { label: 'Author', tokens: ['author', 'authorLastFirst'] },
  { label: 'Title', tokens: ['title', 'titleSort'] },
  { label: 'Series', tokens: ['series', 'seriesPosition'] },
  { label: 'Narrator', tokens: ['narrator', 'narratorLastFirst'] },
  { label: 'Metadata', tokens: ['year', 'edition'] },
];

export const FILE_ONLY_TOKEN_GROUP: TokenGroup = {
  label: 'File-specific',
  tokens: ['trackNumber', 'trackTotal', 'partName'],
};
