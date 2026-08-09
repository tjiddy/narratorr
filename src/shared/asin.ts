// ASIN comparisons are case-insensitive, but SQLite text uniqueness is not. Trim
// and uppercase at every boundary; blanks become null for the partial unique index.
export function canonicalizeAsin(asin: string | null | undefined): string | null {
  if (asin == null) return null;
  const trimmed = asin.trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}
