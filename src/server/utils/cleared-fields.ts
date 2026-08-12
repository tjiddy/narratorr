import type { FastifyBaseLogger } from 'fastify';
import {
  CLEARABLE_BOOK_FIELDS,
  clearedFieldsSchema,
  type ClearableBookField,
} from '@shared/schemas/book.js';

// Tombstones for operator-cleared metadata: forgiving persisted-text reads, strict
// canonical writes, and pure PUT recomputation (#2069).

const CLEARABLE_SET: ReadonlySet<string> = new Set<string>(CLEARABLE_BOOK_FIELDS);

// Persisted read boundary: invalid JSON/shape degrades to empty; unknown strings are
// dropped. Never log raw input or the parse exception because V8 may embed source text;
// bookId and validated-shaped unknown names are the only safe diagnostics.
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

// SQLite has no CHECK here: validate, sort, deduplicate, and encode empty as SQL NULL.
export function serializeClearedFields(fields: readonly string[]): string | null {
  const parsed = clearedFieldsSchema.parse(fields);
  const canonical = [...new Set(parsed)].sort();
  return canonical.length === 0 ? null : JSON.stringify(canonical);
}

// Normalize before opening the update transaction so invalid names cause no writes.
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

export type ClearableUpdateBody = Partial<Record<string, unknown>>;

export interface ClearedFieldsRecompute {
  cleared: ClearableBookField[];
  /** Stored overrides: blanks become null; seriesPosition remains numeric, including zero. */
  normalized: Partial<Record<ClearableBookField, string | string[] | number | null>>;
  /** Fields blanked by this update, for membership reconciliation. */
  blanked: ClearableBookField[];
}

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

function carriesKey(body: ClearableUpdateBody, field: ClearableBookField): boolean {
  return field in body && body[field] !== undefined;
}

// A real seriesName clears a prior position tombstone unless this body also supplies
// position. A live name tombstone nulls stored position. Unrelated PUTs rewrite neither.
function applySeriesPairRules(
  next: Set<ClearableBookField>,
  normalized: ClearedFieldsRecompute['normalized'],
  body: ClearableUpdateBody,
): void {
  const namePresent = carriesKey(body, 'seriesName');
  const positionPresent = carriesKey(body, 'seriesPosition');
  if (!namePresent && !positionPresent) return;

  if (namePresent && normalized.seriesName != null && !positionPresent) {
    next.delete('seriesPosition');
  }

  if (next.has('seriesName')) {
    normalized.seriesPosition = null;
  }
}

// Pure recompute against transaction-local state. Missing/undefined is unchanged;
// null, blank text, or empty genres adds a tombstone and stores null; values remove it.
// Strings stay verbatim, genres drop blanks, and numeric positions include zero/fractions.
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
    // update() treats explicit undefined as omitted.
    if (value === undefined) continue;

    if (field === 'genres') {
      const kept = Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : [];
      applyKey(next, normalized, blanked, field, kept.length === 0 ? null : kept);
      continue;
    }

    if (field === 'seriesPosition') {
      // Only null clears a numeric position; the schema rejects other types upstream.
      if (typeof value === 'number') applyKey(next, normalized, blanked, field, value);
      else if (value === null) applyKey(next, normalized, blanked, field, null);
      continue;
    }

    applyKey(next, normalized, blanked, field, isBlankString(value) ? null : (value as string | null));
  }

  applySeriesPairRules(next, normalized, body);

  return { cleared: [...next].sort(), normalized, blanked };
}

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
