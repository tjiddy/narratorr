// ASIN comparisons are case-insensitive, but SQLite text uniqueness is not. Trim
// and uppercase at every boundary; blanks become null for the partial unique index.
export function canonicalizeAsin(asin: string | null | undefined): string | null {
  if (asin == null) return null;
  const trimmed = asin.trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}

const AUDIBLE_ASIN = /^B[A-Z0-9]{9}$/;

// Full-string, not substring: this gates values read from structured identifier fields, where an
// ASIN surrounded by prose is a malformed field rather than an identity worth probing a provider
// with. Substring scanning of free-form audio tags stays where it is, in the scanner.
export function isAudibleAsin(asin: string | null | undefined): boolean {
  const canonical = canonicalizeAsin(asin);
  return canonical !== null && AUDIBLE_ASIN.test(canonical);
}
