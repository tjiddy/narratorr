// Leaf primitives for folder parsing (issue #1557). Holds the runtime symbols
// that both folder-parsing.ts and folder-parsing-patterns.ts share, so neither
// sibling has to import the other for them. This module imports nothing from
// either sibling — it is the bottom of the one-way dependency graph:
//   folder-parsing.ts ─▶ folder-parsing-patterns.ts ─▶ folder-parsing-primitives.ts
//   folder-parsing.ts ───────────────────────────────▶ folder-parsing-primitives.ts

// ─── Regex Constants ────────────────────────────────────────────────

/** Codec/format tags to strip from folder names (case-insensitive, word-boundary). */
export const CODEC_TAGS = ['MP3', 'M4B', 'M4A', 'FLAC', 'OGG', 'AAC', 'Unabridged', 'Abridged'];

/** Non-global codec regex for `.test()` guards — no `lastIndex` state between calls. */
export const CODEC_TEST_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'i');

/**
 * Matches a trailing parenthetical containing a person's name (1-3 words).
 * Does NOT match: years (2020), codec tags (handled by CODEC_REGEX), or long subtitles (>3 words).
 */
export const NARRATOR_PAREN_REGEX = /\s*\((?!(?:19|20)\d{2}\))(\S+(?:\s+\S+){0,2})\)\s*$/;

const EDITION_PAREN_YEAR_PREFIX = /^(?:19|20)\d{2}\b/;
const EDITION_PAREN_ORDINAL_PREFIX = /^\d+(?:st|nd|rd|th)\b/i;
const EDITION_PAREN_KEYWORD = /\b(?:Edition|Recording|Cut|Version|Mix)\b/i;

export function isEditionParen(content: string): boolean {
  return EDITION_PAREN_YEAR_PREFIX.test(content)
    || EDITION_PAREN_ORDINAL_PREFIX.test(content)
    || EDITION_PAREN_KEYWORD.test(content);
}

/** P9: `Last, First` author convention — exactly two name-shaped tokens around a comma. */
const LAST_FIRST_AUTHOR_REGEX = /^([\w'.-]+),\s*([\w'.-]+)$/;

/** Apply P9 swap: `Last, First` → `First Last`. No-op if pattern doesn't match. */
export function applyLastFirstSwap(author: string): string {
  const match = author.match(LAST_FIRST_AUTHOR_REGEX);
  if (match) return `${match[2]} ${match[1]}`;
  return author;
}
