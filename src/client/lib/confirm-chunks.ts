import type { StagedImportItem } from '@core/import-staging/schemas.js';

/** Byte-budgeted chunk packer for Library/Manual Import requests below the 1 MiB body limit. */

// Target serialized chunk size, well under 1 MiB.
export const CHUNK_BYTE_BUDGET = 400 * 1024;
// The single-item transport ceiling leaves room for the envelope; larger items are diverted pre-flight.
export const MAX_SINGLE_ITEM_BYTES = 900 * 1024;
// Prevents huge requests composed of tiny items.
export const MAX_CHUNK_ITEMS = 200;

const encoder = new TextEncoder();

export interface StagedPutRow {
  ordinal: number;
  item: StagedImportItem;
}

/** Exact UTF-8 size of the full `{ items: rows }` request, including wrapper and commas. */
export function stagedRequestBytes(rows: readonly StagedPutRow[]): number {
  return encoder.encode(JSON.stringify({ items: rows })).length;
}

/**
 * Greedily packs by full request size and count. A lone row may exceed the chunk target because
 * classification already enforces the single-item ceiling.
 */
export function packStagedChunks(rows: readonly StagedPutRow[]): StagedPutRow[][] {
  const chunks: StagedPutRow[][] = [];
  let current: StagedPutRow[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };

  for (const row of rows) {
    const overflowsBudget = current.length > 0 && stagedRequestBytes([...current, row]) > CHUNK_BYTE_BUDGET;
    const overflowsCount = current.length >= MAX_CHUNK_ITEMS;
    if (overflowsBudget || overflowsCount) flush();
    current.push(row);
  }
  flush();

  return chunks;
}
