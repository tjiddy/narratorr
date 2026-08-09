// Dependency-free seam between the renderer and settings schemas. Separator and
// case literals are persisted; do not rename them.

export const namingSeparatorValues = ['space', 'period', 'underscore', 'dash'] as const;
export type NamingSeparator = (typeof namingSeparatorValues)[number];

export const namingCaseValues = ['default', 'lower', 'upper', 'title'] as const;
export type NamingCase = (typeof namingCaseValues)[number];

export const FOLDER_ALLOWED_TOKENS = [
  'author', 'authorLastFirst',
  'title', 'titleSort',
  'series', 'seriesPosition',
  'year',
  'narrator', 'narratorLastFirst',
  'edition',
] as const;

export const FILE_ALLOWED_TOKENS = [
  ...FOLDER_ALLOWED_TOKENS,
  'trackNumber', 'trackTotal', 'partName',
] as const;

// Supports {name}, {name:digits}, {name?text}, {text?name}, and combined forms.
// Captures prefix, token, padding, suffix; disambiguateTokenMatch is suffix-first.
export const TOKEN_PATTERN_SOURCE = String.raw`\{(?:([^}?]*?)\?)?(\w+)(?::(\d+))?(?:\?([^}]*))?\}`;
