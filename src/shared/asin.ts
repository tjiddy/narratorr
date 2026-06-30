/**
 * Canonical ASIN form for narratorr's identity/dedup contract (#1733).
 *
 * ASIN identity is case-insensitive everywhere it is *compared* — the
 * recording-identity resolver and `book-dedup` both lowercase both sides — but
 * the value was historically stored verbatim. A case-drifted write (`'b0..'` vs
 * a stored `'B0..'`) could therefore slip two rows past both the app-level guard
 * (`findAsinCollision`, the only case-sensitive comparison site) AND the durable
 * unique index (case-sensitive SQLite text), producing two owned rows the
 * resolver itself considers the same recording.
 *
 * This helper is the single canonical form, applied at every write boundary, by
 * `findAsinCollision`, and by the durable `upper(asin)` unique index. UPPERCASE
 * is the canonical case: it matches provider B0-prefixed ASINs (Audible /
 * Audnexus) and the existing `findLibraryStatusByAsins` uppercase return-key
 * convention. Trim, then uppercase; a null/undefined/empty-after-trim value
 * folds to `null` so a blank ASIN never collides and the partial
 * `WHERE asin IS NOT NULL` index stays null-tolerant.
 */
export function canonicalizeAsin(asin: string | null | undefined): string | null {
  if (asin == null) return null;
  const trimmed = asin.trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}
