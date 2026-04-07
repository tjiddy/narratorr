/**
 * Canonical list of supported languages for the multi-select settings picker
 * and metadata schema validation. Hand-authored `as const` tuple required for
 * `z.enum()` compatibility. Alphabetically sorted lowercase full names matching
 * the unique values from `KNOWN_NAMES` in `language-codes.ts`.
 */
export const CANONICAL_LANGUAGES = [
  'arabic',
  'bulgarian',
  'catalan',
  'chinese',
  'croatian',
  'czech',
  'danish',
  'dutch',
  'english',
  'estonian',
  'finnish',
  'french',
  'german',
  'greek',
  'hebrew',
  'hindi',
  'hungarian',
  'italian',
  'japanese',
  'korean',
  'latvian',
  'lithuanian',
  'norwegian',
  'polish',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'slovak',
  'slovenian',
  'spanish',
  'swedish',
  'thai',
  'turkish',
  'ukrainian',
  'vietnamese',
] as const;

export type CanonicalLanguage = (typeof CANONICAL_LANGUAGES)[number];
