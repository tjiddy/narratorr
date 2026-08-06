import type { FastifyBaseLogger } from 'fastify';
import {
  CLEARABLE_BOOK_FIELDS,
  clearedFieldsSchema,
  type ClearableBookField,
} from '@shared/schemas/book.js';

/**
 * Operator-asserted absences ("tombstones") for `books.user_cleared_fields` (#2069).
 *
 * The column is PLAIN TEXT (see `src/db/schema.ts`), so nothing decodes it in the
 * driver. This module is the only place that turns the stored bytes into behavior:
 *
 *  - {@link parseClearedFields} — the READ boundary. Warn-and-degrades, never throws.
 *  - {@link serializeClearedFields} — the WRITE boundary. Validates through
 *    `clearedFieldsSchema` and THROWS on an unknown name, and emits the canonical
 *    form (sorted ascending, deduplicated, empty set as SQL NULL).
 *  - {@link recomputeClearedFields} — the pure add/remove rules for a `PUT` body.
 */

const CLEARABLE_SET: ReadonlySet<string> = new Set<string>(CLEARABLE_BOOK_FIELDS);

/**
 * Parse a persisted `user_cleared_fields` column into its sanitized set.
 *
 * Takes the RAW column string (the `parsePhaseHistory` precedent) and degrades
 * rather than throwing, matching the two existing persisted-JSON read boundaries
 * in this repo (`parsePhaseHistory`, the quality-gate reason parser). Throwing
 * here would turn one corrupt row into an unreadable book detail page and a
 * permanently stuck enrichment candidate — strictly worse than losing a tombstone
 * that can only become corrupt through an out-of-band DB edit, since every in-app
 * write is validated by {@link serializeClearedFields}.
 *
 * Policy:
 *  - unparseable JSON / non-array / non-string element → empty set + one `log.warn`;
 *  - unknown names → dropped, recognized names kept, one `log.warn` naming the drops;
 *  - SQL NULL and a legacy `'[]'` both parse to the empty set with no warning.
 *
 * **The raw column value is NEVER logged** — only `bookId`, and the dropped names
 * once they are known to be recognized-shaped strings. In particular the
 * unparseable arm logs NO error object: V8's `SyntaxError.message` embeds a
 * snippet of the offending source (`JSON.parse('{"a": bad}')` →
 * `Unexpected token 'b', "{"a": bad}" is not valid JSON`), and `serializeError`
 * copies `message` and `stack` while redacting only URLs — so passing the parse
 * exception through would reproduce persisted content in logs and break AC4's
 * absolute no-raw rule. The `{oops` shape happens NOT to echo, which is exactly why
 * a single-input test could not catch this. `bookId` is the whole diagnostic need:
 * it identifies the row to inspect out of band.
 *
 * This mirrors the quality-gate reason parser, which logs Zod issue PATHS and never
 * the field values (`quality-gate.service.ts`, #1404).
 */
export function parseClearedFields(
  raw: string | null,
  log: FastifyBaseLogger,
  bookId: number,
): ClearableBookField[] {
  if (!raw) return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    log.warn({ bookId }, 'Unparseable userClearedFields JSON; treating as no tombstones');
    return [];
  }

  if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== 'string')) {
    log.warn({ bookId }, 'Malformed userClearedFields; treating as no tombstones');
    return [];
  }

  const known: ClearableBookField[] = [];
  const dropped: string[] = [];
  for (const entry of decoded as string[]) {
    if (CLEARABLE_SET.has(entry)) known.push(entry as ClearableBookField);
    else dropped.push(entry);
  }
  if (dropped.length > 0) {
    log.warn({ bookId, dropped }, 'Unknown userClearedFields entries dropped');
  }
  return [...new Set(known)].sort();
}

/**
 * Canonical serialization for every in-app write (AC2/AC3).
 *
 * Validates through `clearedFieldsSchema` and THROWS on an unknown name — SQLite
 * text columns emit no DB CHECK, so this is the only enforcement point. The output
 * is sorted ascending and deduplicated, and the empty set is SQL `NULL` (never
 * `'[]'`), so the stored text is a function of its set value: a no-op rewrite
 * cannot change the bytes and tests have one form to assert against.
 */
export function serializeClearedFields(fields: readonly string[]): string | null {
  const parsed = clearedFieldsSchema.parse(fields);
  const canonical = [...new Set(parsed)].sort();
  return canonical.length === 0 ? null : JSON.stringify(canonical);
}

/**
 * Write-boundary normalization for a caller-supplied RAW column value (AC2).
 * `BookService.update` runs this before opening its transaction, so a payload
 * carrying an unknown field name rejects without issuing any write.
 */
export function normalizeClearedFieldsColumn(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('userClearedFields must be a JSON-encoded array of clearable field names');
  }
  return serializeClearedFields(clearedFieldsSchema.parse(decoded));
}

/** A `PUT /api/books/:id` body, as far as the recompute is concerned. */
export type ClearableUpdateBody = Partial<Record<string, unknown>>;

export interface ClearedFieldsRecompute {
  /** The new tombstone set — canonical (sorted, deduplicated). */
  cleared: ClearableBookField[];
  /**
   * Stored-value overrides to merge over the request body (AC7). A blank value
   * for a clearable field normalizes to NULL and blank `genres` elements are
   * dropped, so the stored value can never contradict the tombstone. Carries a
   * NUMBER for `seriesPosition` (#2152) — `0` and fractional positions like `3.5`
   * are ordinary values, never a clear.
   */
  normalized: Partial<Record<ClearableBookField, string | string[] | number | null>>;
  /** The clearable fields this body just blanked — drives AC14's membership reconcile. */
  blanked: ClearableBookField[];
}

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/** True when the body carries a usable (non-`undefined`) value for `field`. */
function carriesKey(body: ClearableUpdateBody, field: ClearableBookField): boolean {
  return field in body && body[field] !== undefined;
}

/**
 * The two series-specific pair rules (#2152 AC4), applied AFTER the uniform
 * per-key pass has decided each key on its own. Everything else in the matrix is
 * the uniform rule with no series branch — these are the only coupled cells.
 *
 *  - **(a)** a non-blank `seriesName` re-asserts the pair and drops a
 *    `seriesPosition` tombstone (rows 4/5) — unless the same body carries its own
 *    `seriesPosition` key, which always wins (row 6).
 *  - **(b)** whenever the `seriesName` tombstone is LIVE after this recompute —
 *    the body blanked it (rows 7–9) or it was already live (rows 2b/3) — the
 *    `series_position` COLUMN normalizes to NULL. It does NOT touch the
 *    `seriesPosition` tombstone, which is decided by its own key. Storing a
 *    position beside a cleared name would mint exactly the position-without-series
 *    shape #2152 exists to remove, and both rename token maps read the raw column.
 *
 * Rule **b** fires ONLY for bodies carrying at least one series key: an unrelated
 * `PUT { subtitle }` (matrix row 1) must not rewrite series columns, so a legacy
 * name-tombstoned row with a stale position is left exactly as it is.
 */
function applySeriesPairRules(
  next: Set<ClearableBookField>,
  normalized: ClearedFieldsRecompute['normalized'],
  body: ClearableUpdateBody,
): void {
  const namePresent = carriesKey(body, 'seriesName');
  const positionPresent = carriesKey(body, 'seriesPosition');
  if (!namePresent && !positionPresent) return;

  // (a) — keyed on the body asserting a real name, i.e. the name half did not blank.
  if (namePresent && normalized.seriesName != null && !positionPresent) {
    next.delete('seriesPosition');
  }

  // (b) — the column follows the name tombstone, whoever set it.
  if (next.has('seriesName')) {
    normalized.seriesPosition = null;
  }
}

/**
 * Recompute the tombstone set from a `PUT` body (AC6/AC7). PURE — no I/O, no
 * clock. The caller runs it inside the write transaction against a set it re-read
 * there, so two concurrent edits cannot interleave into a stale set.
 *
 * Per clearable key:
 *
 * | body state                              | tombstone | stored          |
 * |-----------------------------------------|-----------|-----------------|
 * | key absent                              | unchanged | unchanged       |
 * | `null`                                  | added     | NULL            |
 * | `''` / whitespace-only string           | added     | NULL            |
 * | `genres: []` or `['', '  ']`            | added     | NULL            |
 * | non-blank string                        | removed   | verbatim        |
 * | `genres` with ≥1 non-blank element      | removed   | blanks dropped  |
 * | `seriesPosition` number (incl. `0`/`3.5`)| removed  | verbatim number |
 *
 * A non-blank string is stored VERBATIM — no trimming — matching `diffDescription`,
 * which deliberately preserves interior whitespace. `seriesPosition` is NUMERIC:
 * `0` is a position, not a clear, so nothing on this path may use `||`.
 *
 * On top of that uniform pass sit the two pair rules in
 * {@link applySeriesPairRules} — the whole of #2152 AC4's series-specific policy,
 * and its only home: `BookService.runUpdate` merges `normalized` verbatim and
 * re-derives no cell. Keys outside `CLEARABLE_BOOK_FIELDS` (`coverUrl`, `status`,
 * `title`, `authors`, `narrators`) never affect the set.
 */
export function recomputeClearedFields(
  current: readonly ClearableBookField[],
  body: ClearableUpdateBody,
): ClearedFieldsRecompute {
  const next = new Set<ClearableBookField>(current);
  const normalized: ClearedFieldsRecompute['normalized'] = {};
  const blanked: ClearableBookField[] = [];

  for (const field of CLEARABLE_BOOK_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    // An explicit `undefined` is the same as an absent key everywhere else in
    // `update()` ("omitted = unchanged"), so it must not read as a clear here.
    if (value === undefined) continue;

    if (field === 'genres') {
      const kept = Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : [];
      applyKey(next, normalized, blanked, field, kept.length === 0 ? null : kept);
      continue;
    }

    if (field === 'seriesPosition') {
      // Numeric semantics: only an explicit `null` clears. A non-number is not
      // producible through `updateBookBodySchema` (`z.number().nullable()` inside
      // `.strict()`); treat it as no-op rather than inventing a coercion.
      if (typeof value === 'number') applyKey(next, normalized, blanked, field, value);
      else if (value === null) applyKey(next, normalized, blanked, field, null);
      continue;
    }

    applyKey(next, normalized, blanked, field, isBlankString(value) ? null : (value as string | null));
  }

  applySeriesPairRules(next, normalized, body);

  return { cleared: [...next].sort(), normalized, blanked };
}

/**
 * The uniform per-key rule, shared by all seven fields: a `null` decision adds
 * the tombstone, NULLs the stored value and reports the field in `blanked`; any
 * other value removes the tombstone and stores verbatim.
 */
function applyKey(
  next: Set<ClearableBookField>,
  normalized: ClearedFieldsRecompute['normalized'],
  blanked: ClearableBookField[],
  field: ClearableBookField,
  value: string | string[] | number | null,
): void {
  if (value === null) {
    next.add(field);
    blanked.push(field);
    normalized[field] = null;
  } else {
    next.delete(field);
    normalized[field] = value;
  }
}
