import { stagedImportItemSchema, type StagedImportItem } from '../../../core/import-staging/schemas.js';
import type { ImportConfirmItem } from '@/lib/api';
import { MAX_SINGLE_ITEM_BYTES } from '@/lib/confirm-chunks.js';

/**
 * Parse-once classification of the selected rows (#1902, F1/F16/F17/F44/F39).
 *
 * For each selected row the caller has already built an EXACTLY-shaped candidate
 * (the `stagedImportItemSchema` fields only, as `toConfirmItem` does — the staged
 * wire schema is `.strict()` and rejects unknown keys). Here we `safeParse` each
 * candidate through `stagedImportItemSchema` — the SAME schema the PUT route parses
 * with — and split the rows into three buckets by a single deterministic rule:
 *
 *  - **oversize** — "purely too large": the serialized-item UTF-8 bytes exceed the
 *    per-item transport ceiling `MAX_SINGLE_ITEM_BYTES`, OR the parse fails and EVERY
 *    Zod issue is a `too_big` code (any `.max()` overflow — scalar length, array
 *    element length, or array count).
 *  - **invalid** — the parse fails with at least one NON-`too_big` issue
 *    (`unrecognized_keys`, `invalid_format`, `invalid_type`, `too_small`, …). A row
 *    carrying BOTH a `too_big` and a non-`too_big` issue is invalid — structurally
 *    wrong, not merely large.
 *  - **survivor** — a clean parse yields the NORMALIZED output (trimmed/bounded
 *    values). These become the single frozen source array (ordinals compacted
 *    `0..n-1` over it) used for byte accounting, the client digest, and every PUT.
 *
 * Excluded rows are dropped BEFORE ordinal compaction (no gaps) and counted
 * separately. Because both client and server hash the parse OUTPUT, a value that
 * differs only by pre-trim whitespace hashes identically to its persisted form.
 */

const encoder = new TextEncoder();

/** Serialized UTF-8 byte size of a single staged item (the per-item transport measure). */
function itemBytes(item: unknown): number {
  return encoder.encode(JSON.stringify(item)).length;
}

export interface ClassifiedSubmission {
  /** Frozen, normalized parse output — the single source for bytes/digest/PUT. Ordinal = index. */
  survivors: readonly StagedImportItem[];
  /** Index into the input `candidates` array for each survivor (parallel to `survivors`). */
  survivorSourceIndexes: readonly number[];
  /** Input indexes of rows excluded as invalid (structurally wrong). */
  invalidIndexes: readonly number[];
  /** Input indexes of rows excluded as oversize (purely too large). */
  oversizeIndexes: readonly number[];
  invalidCount: number;
  oversizeCount: number;
}

export function classifySubmission(candidates: readonly ImportConfirmItem[]): ClassifiedSubmission {
  const survivors: StagedImportItem[] = [];
  const survivorSourceIndexes: number[] = [];
  const invalidIndexes: number[] = [];
  const oversizeIndexes: number[] = [];

  candidates.forEach((candidate, index) => {
    const parsed = stagedImportItemSchema.safeParse(candidate);
    if (parsed.success) {
      if (itemBytes(parsed.data) > MAX_SINGLE_ITEM_BYTES) {
        oversizeIndexes.push(index);
      } else {
        survivors.push(parsed.data);
        survivorSourceIndexes.push(index);
      }
      return;
    }
    const issues = parsed.error.issues;
    const allTooBig = issues.length > 0 && issues.every((issue) => issue.code === 'too_big');
    if (itemBytes(candidate) > MAX_SINGLE_ITEM_BYTES || allTooBig) {
      oversizeIndexes.push(index);
    } else {
      invalidIndexes.push(index);
    }
  });

  return {
    survivors: Object.freeze(survivors),
    survivorSourceIndexes: Object.freeze(survivorSourceIndexes),
    invalidIndexes: Object.freeze(invalidIndexes),
    oversizeIndexes: Object.freeze(oversizeIndexes),
    invalidCount: invalidIndexes.length,
    oversizeCount: oversizeIndexes.length,
  };
}
