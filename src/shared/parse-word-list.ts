export function parseWordList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

// ASCII word boundaries prevent “abridged” matching “unabridged”; these word lists
// are English-only, and escaped multi-word phrases retain their literal spaces.
export function matchesWord(surface: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(surface);
}
