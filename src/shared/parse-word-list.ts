/** Parse a comma-separated word list into trimmed, non-empty lowercase entries. */
export function parseWordList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}
