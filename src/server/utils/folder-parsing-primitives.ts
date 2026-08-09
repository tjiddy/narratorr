export const CODEC_TAGS = ['MP3', 'M4B', 'M4A', 'FLAC', 'OGG', 'AAC', 'Unabridged', 'Abridged'];

/** Non-global codec regex for `.test()` guards — no `lastIndex` state between calls. */
export const CODEC_TEST_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'i');

// Global stripping twin of CODEC_TEST_REGEX.
const CODEC_REGEX = new RegExp(`\\b(${CODEC_TAGS.join('|')})\\b`, 'gi');

export function normalizeFolderName(name: string): string {
  return name
    .replace(/[_.]/g, ' ')
    .replace(CODEC_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const BARE_YEAR_REGEX = /\b((?:19|20)\d{2})\s*$/;

// Shared 1900–2099 window, including year-versus-leading-position disambiguation.
export function isYearInWindow(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2099;
}

/** Extracts a parenthesized, bracketed, or bare trailing year in the shared window. */
export function extractYear(name: string): number | undefined {
  const normalized = normalizeFolderName(name);
  for (const regex of [/\((\d{4})\)\s*$/, /\[(\d{4})\]\s*$/, BARE_YEAR_REGEX]) {
    const match = normalized.match(regex);
    if (!match) continue;
    const year = parseInt(match[1]!, 10);
    if (isYearInWindow(year)) return year;
  }
  return undefined;
}

// A trailing 1–3-word person name, excluding year-shaped content.
export const NARRATOR_PAREN_REGEX = /\s*\((?!(?:19|20)\d{2}\))(\S+(?:\s+\S+){0,2})\)\s*$/;

const EDITION_PAREN_YEAR_PREFIX = /^(?:19|20)\d{2}\b/;
const EDITION_PAREN_ORDINAL_PREFIX = /^\d+(?:st|nd|rd|th)\b/i;
const EDITION_PAREN_KEYWORD = /\b(?:Edition|Recording|Cut|Version|Mix)\b/i;

export function isEditionParen(content: string): boolean {
  return EDITION_PAREN_YEAR_PREFIX.test(content)
    || EDITION_PAREN_ORDINAL_PREFIX.test(content)
    || EDITION_PAREN_KEYWORD.test(content);
}

const LAST_FIRST_AUTHOR_REGEX = /^([\w'.-]+),\s*([\w'.-]+)$/;

export function applyLastFirstSwap(author: string): string {
  const match = author.match(LAST_FIRST_AUTHOR_REGEX);
  if (match) return `${match[2]} ${match[1]}`;
  return author;
}
