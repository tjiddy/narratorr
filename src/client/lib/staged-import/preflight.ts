import { EXPECTED_COUNT_MAX, MAX_SUBMISSION_BYTES, type StagedImportItem } from '../../../core/import-staging/schemas.js';

/**
 * Post-exclusion preflight gates (#1902, F30/F31/F39/F41).
 *
 * After classification has dropped invalid + oversize rows, the surviving set is
 * checked against three bounds in a FIXED precedence so a batch that trips more than
 * one produces exactly one deterministic outcome:
 *   1. zero survivors (F39) — short-circuit, create nothing;
 *   2. row-count over `EXPECTED_COUNT_MAX` (F31) — refuse the whole batch;
 *   3. cumulative canonical bytes over `MAX_SUBMISSION_BYTES` (F30) — refuse.
 * Only the first tripped gate reports; in every non-`ok` case NO UUID/hint/create is
 * generated and all rows stay selected. The byte measure is the SAME per-item
 * `JSON.stringify(item)` UTF-8 sum the server enforces, so client and server agree.
 */

const encoder = new TextEncoder();

/** Canonical per-item byte size (matches the server's `Buffer.byteLength(JSON.stringify(item))`). */
export function stagedItemBytes(item: StagedImportItem): number {
  return encoder.encode(JSON.stringify(item)).length;
}

/** Sum of the canonical per-item bytes across the surviving set (the F30/F58 accumulator). */
export function cumulativeStagedBytes(items: readonly StagedImportItem[]): number {
  let total = 0;
  for (const item of items) total += stagedItemBytes(item);
  return total;
}

export type PreflightGate =
  | { kind: 'ok' }
  | { kind: 'zero-survivors' }
  | { kind: 'row-count'; count: number }
  | { kind: 'byte-budget'; bytes: number };

/** Exact pinned copy for the two static refusal gates (the zero-survivor copy is count-composed by the UI). */
export const PREFLIGHT_COPY = {
  rowCount: 'Too many books selected (max 10,000) — import in smaller batches',
  byteBudget: 'Selection is too large to import at once — deselect some books',
} as const;

export function preflightSubmission(survivors: readonly StagedImportItem[]): PreflightGate {
  if (survivors.length === 0) return { kind: 'zero-survivors' };
  if (survivors.length > EXPECTED_COUNT_MAX) return { kind: 'row-count', count: survivors.length };
  const bytes = cumulativeStagedBytes(survivors);
  if (bytes > MAX_SUBMISSION_BYTES) return { kind: 'byte-budget', bytes };
  return { kind: 'ok' };
}
