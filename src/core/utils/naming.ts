import {
  type NamingSeparator,
  type NamingCase,
  FOLDER_ALLOWED_TOKENS,
  FILE_ALLOWED_TOKENS,
  TOKEN_PATTERN_SOURCE,
} from '../../shared/naming-constants.js';
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

/** Backward-compatible alias. */
export const ALLOWED_TOKENS = FOLDER_ALLOWED_TOKENS;

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

/**
 * Strip a trailing reserved import-sibling suffix (#1341) so a metadata-derived folder can
 * never end in `.import-bak` / `.import-tmp` / `.import-commit-pending` — names that a
 * library scan would mistake for transient scratch (excluding a real book) or that would
 * collide destructively with the commit-pending marker path. Loops so a doubled suffix
 * (`Foo.import-bak.import-bak`) unwinds fully, re-trimming trailing dots/whitespace exposed
 * by each strip. Case-sensitive against the lowercase constants. A title that merely
 * CONTAINS the substring but does not END in it (`My .import-bak Notes`) is untouched, as
 * is a title ending in a partial token without the `.import` prefix (`Project Backup-bak`).
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

/** Sanitize a string for use as a filesystem path segment. */
export function sanitizePath(segment: string): string {
  let result = segment
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s{2,}/g, ' ') // collapse consecutive spaces
    .replace(/\.+$/, '') // trailing dots (Windows)
    .trim();

  // Truncate to filesystem limit FIRST — truncation can itself slice a longer title down to
  // a segment that ends in a reserved suffix (#1341 F1: `'A'.repeat(244) + '.import-bak' + 'x'`
  // truncates to a 255-char `…A.import-bak`), so the suffix reservation must be the FINAL pass.
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = result.slice(0, MAX_SEGMENT_LENGTH).trim();
  }

  // Reserve the import-sibling suffixes (#1341): never emit a segment ending in one — whether
  // the suffix came from the raw title or was produced by the truncation above.
  result = stripReservedSuffixes(result);

  return result || 'Unknown';
}

/** Filesystem path-segment length limit, exposed for the folder builders' leaf budgeting (#1739). */
export const PATH_SEGMENT_LIMIT = MAX_SEGMENT_LENGTH;

/**
 * Sanitize an edition label into ONE filesystem-path-safe discriminator segment (#1739).
 *
 * The single shared seam consumed by BOTH folder branches (`buildTargetPath` / `computeFolderTarget`):
 * the in-place `{edition}` token AND the mandatory collision suffix. Co-located with `sanitizePath`
 * so it reuses the private `ILLEGAL_CHARS` + `stripReservedSuffixes` without exporting them — the two
 * paths can never diverge on what is path-safe again.
 *
 * Strips path separators + the full illegal/control-char set (`ILLEGAL_CHARS` covers `/ \ < > : " | ? *`
 * and `\x00-\x1f`), collapses whitespace, drops trailing dots, caps at the segment limit, and reserves
 * the import-sibling suffixes. Returns `null` (NOT `'Unknown'`) when the result is empty so the caller
 * treats it exactly like a null label and renders the unchanged base path.
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
 * Compose the suffix-branch leaf `base (discriminator)` (#1739), budgeting the BASE down so the
 * discriminator survives the segment-length cap rather than being silently truncated away. The
 * discriminator is appended VERBATIM (already sanitized by `sanitizeEditionDiscriminator`), so the
 * suffix branch yields a byte-identical discriminator to the verbatim `{edition}` token branch.
 *
 * Budget order (F7): the base title is truncated first; a non-empty discriminator always survives.
 * Only a pathologically long discriminator — whose own ` (…)` wrapper alone exceeds the segment cap —
 * is itself truncated, and never to empty. The composed leaf is re-run through the reserved
 * import-sibling-suffix guard (AC5) so it can never end in `.import-bak` / `.import-tmp` /
 * `.import-commit-pending`.
 */
export function composeEditionSuffixLeaf(base: string, discriminator: string): string {
  const suffix = ` (${discriminator})`;
  const budget = MAX_SEGMENT_LENGTH - suffix.length;
  let leaf: string;
  if (budget <= 0) {
    // The discriminator + ` ()` wrapper alone exceed the segment limit. Base-first truncation (F7):
    // sacrifice the base ENTIRELY before touching the discriminator, then truncate the discriminator
    // itself only as far as the bare `()` wrapper requires — never to empty — so a pathologically
    // long discriminator still stays visible rather than being buried behind base text.
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
  // Tokens whose value must render VERBATIM, bypassing separator/case transforms (#1739).
  // `renderTemplate` (folder paths) passes `edition` so the in-place `{edition}` token matches
  // the verbatim suffix branch; `renderFilename` leaves it empty so file/audio `{edition}`
  // rendering is unchanged (it keeps applying namingSeparator/namingCase, F8).
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

      // Format specifier: {seriesPosition:00} → zero-pad
      if (padSpec) {
        const num = Number(value);
        if (!isNaN(num)) {
          value = String(num).padStart(padSpec.length, '0');
        }
      }

      // Apply separator/case transforms to non-numeric token values — unless the token is
      // marked verbatim (#1739: the folder `{edition}` discriminator is metadata identity, not
      // a stylable title token, so it must render identically to the verbatim suffix branch).
      if (!isNumericFormatted(padSpec, raw) && !verbatimTokens?.has(name)) {
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
 * Tokens rendered VERBATIM in FOLDER templates (#1739) \u2014 the `{edition}` discriminator bypasses
 * `namingSeparator`/`namingCase` so the token branch and the mandatory suffix branch produce a
 * byte-identical discriminator. Scoped to `renderTemplate` (folders) only; `renderFilename` does
 * NOT pass this set, so file/audio `{edition}` rendering keeps applying the transforms (F8).
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
  // Only strip wrappers that contain at least one sentinel (i.e., came from an empty token)
  const wrapperPattern = /\(\s*\u200B[\s\u200B]*\)|\[\s*\u200B[\s\u200B]*\]/g;
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(wrapperPattern, '');
  } while (result !== prev);
  // Remove remaining sentinels and clean up whitespace
  result = result.replace(SENTINEL_REGEX, '');
  return result.replace(/ {2,}/g, ' ').trim();
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
  const rendered = stripEmptyWrappers(resolveTokens(template, tokens, options, FOLDER_VERBATIM_TOKENS));

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
  const rendered = stripEmptyWrappers(resolveTokens(template, tokens, options));
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
      match[1], match[2]!, match[3], match[4], allowedSet,
    );
    if (!tokens.includes(name)) {
      tokens.push(name);
    }
    if (!allowedSet.has(name)) {
      errors.push(`Unknown token: {${name}}`);
    }
  }

  // Only check for required tokens if the template is non-empty
  if (template && !tokens.includes('title') && !tokens.includes('titleSort')) {
    errors.push('Template must include {title} or {titleSort}');
  }

  if (template && !tokens.includes('author') && !tokens.includes('authorLastFirst')) {
    warnings.push('Consider including {author} or {authorLastFirst} for better organization');
  }

  return { tokens, errors, warnings };
}

/**
 * True when `template` contains the given token (after suffix-first
 * disambiguation). Used by the import/rename target builders to decide whether a
 * user-supplied `{edition}` token already renders the edition label in place — in
 * which case the mandatory collision suffix must NOT also be appended (#1712), or
 * the label would render twice.
 */
export function templateHasToken(template: string, token: string): boolean {
  return parseTemplate(template, FILE_ALLOWED_TOKENS).tokens.includes(token);
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
  { label: 'Metadata', tokens: ['year', 'edition'] },
];

export const FILE_ONLY_TOKEN_GROUP: TokenGroup = {
  label: 'File-specific',
  tokens: ['trackNumber', 'trackTotal', 'partName'],
};
