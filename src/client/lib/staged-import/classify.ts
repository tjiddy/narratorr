import { stagedImportItemSchema, type StagedImportItem } from '@core/import-staging/schemas.js';
import type { ImportConfirmItem } from '@/lib/api';
import { MAX_SINGLE_ITEM_BYTES } from '@/lib/confirm-chunks.js';

// Only pure size violations are oversize; mixed Zod failures are invalid.
// Normalized survivors define byte accounting, digest input, and compacted PUT ordinals.

const encoder = new TextEncoder();

function itemBytes(item: unknown): number {
  return encoder.encode(JSON.stringify(item)).length;
}

export interface ClassifiedSubmission {
  /** Frozen normalized output; index is the compacted ordinal. */
  survivors: readonly StagedImportItem[];
  survivorSourceIndexes: readonly number[];
  invalidIndexes: readonly number[];
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
