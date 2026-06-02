/** Parse a comma-separated word list into trimmed, non-empty lowercase entries. */
export function parseWordList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * Word-boundary, case-insensitive match of a word/phrase against a surface.
 * Prevents substring collisions like "abridged" matching "unabridged". Used by
 * both the reject-word and required-word search filters.
 *
 * `\b` in JS only recognizes ASCII word boundaries — fine for the English-language
 * scope of these word lists. Multi-word phrases (e.g. "Behind the Scenes") still
 * work because escaping leaves internal spaces literal and `\b` anchors at the
 * outer ends.
 */
export function matchesWord(surface: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(surface);
}
