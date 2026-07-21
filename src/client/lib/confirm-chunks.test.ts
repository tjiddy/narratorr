import { describe, it, expect } from 'vitest';
import {
  CHUNK_BYTE_BUDGET,
  MAX_CHUNK_ITEMS,
  packStagedChunks,
  stagedRequestBytes,
  type StagedPutRow,
} from './confirm-chunks.js';
import type { StagedImportItem } from '../../core/import-staging/schemas.js';

/** A staged PUT row whose serialized `item` is padded to roughly `bytes`. */
function stagedRowOfSize(ordinal: number, bytes: number): StagedPutRow {
  const base: StagedImportItem = { path: `/b/${ordinal}`, title: 'T' };
  const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
  const pad = Math.max(0, bytes - overhead);
  return { ordinal, item: { path: `/b/${ordinal}`, title: 'T'.repeat(pad || 1) } };
}

describe('packStagedChunks — {ordinal,item} envelope byte accounting (#1902, F70)', () => {
  it('keeps every full request body under CHUNK_BYTE_BUDGET', () => {
    const rows: StagedPutRow[] = Array.from({ length: 40 }, (_, i) => stagedRowOfSize(i, 40 * 1024));
    const chunks = packStagedChunks(rows);
    expect(chunks.flat()).toHaveLength(40);
    for (const chunk of chunks) {
      expect(stagedRequestBytes(chunk)).toBeLessThanOrEqual(CHUNK_BYTE_BUDGET);
    }
  });

  it('preserves ordinal ordering across chunks', () => {
    const rows: StagedPutRow[] = Array.from({ length: 30 }, (_, i) => stagedRowOfSize(i, 30 * 1024));
    const flat = packStagedChunks(rows).flat();
    expect(flat.map((r) => r.ordinal)).toEqual(rows.map((r) => r.ordinal));
  });

  it('ships a single large row alone in its own request', () => {
    const big = stagedRowOfSize(0, CHUNK_BYTE_BUDGET + 50 * 1024);
    const chunks = packStagedChunks([big]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([big]);
  });

  it('bounds a run of tiny rows by MAX_CHUNK_ITEMS', () => {
    const rows: StagedPutRow[] = Array.from({ length: MAX_CHUNK_ITEMS + 5 }, (_, i) => ({ ordinal: i, item: { path: `/${i}`, title: 'T' } }));
    const chunks = packStagedChunks(rows);
    expect(chunks[0]).toHaveLength(MAX_CHUNK_ITEMS);
    expect(chunks.flat()).toHaveLength(MAX_CHUNK_ITEMS + 5);
  });

  it('accounts multibyte item bytes in the request measure', () => {
    const rows: StagedPutRow[] = [{ ordinal: 0, item: { path: '/日本語', title: '📚' } }];
    expect(stagedRequestBytes(rows)).toBe(Buffer.byteLength(JSON.stringify({ items: rows }), 'utf8'));
  });

  it('emits no chunks for an empty row set', () => {
    expect(packStagedChunks([])).toEqual([]);
  });

  // Boundary: a full request body measured at exactly CHUNK_BYTE_BUDGET stays one chunk;
  // one more row that tips the whole `{items:[...]}` envelope over the budget splits.
  it('keeps a request at/under budget in one chunk; the row that tips the envelope over splits', () => {
    // Pad row 0 so [row0] alone sits just under the budget, then a tiny row 1 tips it over.
    const under = stagedRowOfSize(0, CHUNK_BYTE_BUDGET - 4 * 1024);
    expect(stagedRequestBytes([under])).toBeLessThanOrEqual(CHUNK_BYTE_BUDGET);
    const tiny: StagedPutRow = { ordinal: 1, item: { path: '/t', title: 'x'.repeat(8 * 1024) } };
    expect(stagedRequestBytes([under, tiny])).toBeGreaterThan(CHUNK_BYTE_BUDGET);
    const chunks = packStagedChunks([under, tiny]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([under]);
    expect(chunks[1]).toEqual([tiny]);
  });
});
