import { EXPECTED_COUNT_MAX, MAX_SUBMISSION_BYTES, type StagedImportItem } from '@core/import-staging/schemas.js';

// Apply zero, count, then canonical-byte gates in fixed precedence after exclusions.
// Rejections create no UUID, hint, or request; byte accounting matches the server.

const encoder = new TextEncoder();

// Matches server Buffer.byteLength(JSON.stringify(item)).
export function stagedItemBytes(item: StagedImportItem): number {
  return encoder.encode(JSON.stringify(item)).length;
}

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

// Contract copy for the static refusal gates.
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
