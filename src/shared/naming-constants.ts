/**
 * Naming primitives shared between core (template rendering) and shared (settings schemas).
 *
 * This module has zero internal dependencies — it's the dependency-free seam
 * that lets `core/utils/naming.ts` and `shared/schemas/settings/library.ts`
 * coexist without forming a cycle.
 *
 * Literal values (`'space' | 'period' | 'underscore' | 'dash'`,
 * `'default' | 'lower' | 'upper' | 'title'`) are persisted in user settings —
 * do not change them.
 */

export const namingSeparatorValues = ['space', 'period', 'underscore', 'dash'] as const;
export type NamingSeparator = (typeof namingSeparatorValues)[number];

export const namingCaseValues = ['default', 'lower', 'upper', 'title'] as const;
export type NamingCase = (typeof namingCaseValues)[number];

/** Allowed token names for folder naming templates. */
export const FOLDER_ALLOWED_TOKENS = [
  'author', 'authorLastFirst',
  'title', 'titleSort',
  'series', 'seriesPosition',
  'year',
  'narrator', 'narratorLastFirst',
] as const;

/** File-specific tokens (trackNumber, trackTotal, partName) plus all folder tokens. */
export const FILE_ALLOWED_TOKENS = [
  ...FOLDER_ALLOWED_TOKENS,
  'trackNumber', 'trackTotal', 'partName',
] as const;

/**
 * Token grammar regex source:
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
