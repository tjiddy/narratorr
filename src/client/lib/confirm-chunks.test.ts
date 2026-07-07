import { describe, it, expect } from 'vitest';
import {
  packConfirmChunks,
  serializedItemBytes,
  CHUNK_BYTE_BUDGET,
  MAX_SINGLE_ITEM_BYTES,
  MAX_CHUNK_ITEMS,
} from './confirm-chunks.js';
import type { ImportConfirmItem } from '@/lib/api';

/** A confirm item whose metadata blob pads it to roughly `bytes` serialized. */
function itemOfSize(path: string, bytes: number): ImportConfirmItem {
  const base: ImportConfirmItem = { path, title: 'T', metadata: { blob: '' } as never };
  const overhead = serializedItemBytes(base);
  const pad = Math.max(0, bytes - overhead);
  return { path, title: 'T', metadata: { blob: 'x'.repeat(pad) } as never };
}

describe('packConfirmChunks (#1831)', () => {
  it('packs small items into as few chunks as possible, each under budget', () => {
    // 20 items each ~50 KiB → 8 fit per 400 KiB chunk → 3 chunks.
    const items = Array.from({ length: 20 }, (_, i) => itemOfSize(`/b/${i}`, 50 * 1024));
    const { chunks, tooLarge } = packConfirmChunks(items);

    expect(tooLarge).toHaveLength(0);
    expect(chunks.flat()).toHaveLength(20);
    for (const chunk of chunks) {
      const bytes = chunk.reduce((n, it) => n + serializedItemBytes(it), 0);
      expect(bytes).toBeLessThanOrEqual(CHUNK_BYTE_BUDGET);
    }
    // Order is preserved across the flattened chunks.
    expect(chunks.flat().map(i => i.path)).toEqual(items.map(i => i.path));
  });

  it('ships an item above the chunk budget but under the ceiling alone in its own chunk', () => {
    const big = itemOfSize('/big', 600 * 1024); // > 400 KiB budget, < 900 KiB ceiling
    const small = itemOfSize('/small', 10 * 1024);
    const { chunks, tooLarge } = packConfirmChunks([small, big, small]);

    expect(tooLarge).toHaveLength(0);
    const bigChunk = chunks.find(c => c.some(i => i.path === '/big'));
    expect(bigChunk).toHaveLength(1); // ships alone
    // The lone big-item chunk is still under 1 MiB.
    expect(serializedItemBytes(bigChunk![0]!)).toBeLessThan(1024 * 1024);
  });

  it('diverts a self-oversize item to tooLarge and never emits it in any chunk', () => {
    const huge = itemOfSize('/huge', MAX_SINGLE_ITEM_BYTES + 50 * 1024);
    const ok = itemOfSize('/ok', 20 * 1024);
    const { chunks, tooLarge } = packConfirmChunks([ok, huge, ok]);

    expect(tooLarge.map(i => i.path)).toEqual(['/huge']);
    expect(chunks.flat().map(i => i.path)).toEqual(['/ok', '/ok']);
    expect(chunks.flat().some(i => i.path === '/huge')).toBe(false);
  });

  it('respects the max-count secondary bound even when byte budget is not reached', () => {
    // Tiny items — byte budget never trips, so only the count bound splits them.
    const items = Array.from({ length: MAX_CHUNK_ITEMS + 5 }, (_, i) => ({ path: `/b/${i}`, title: 'T' }));
    const { chunks } = packConfirmChunks(items);

    expect(chunks[0]).toHaveLength(MAX_CHUNK_ITEMS);
    expect(chunks[1]).toHaveLength(5);
  });

  it('carries review-step edits through into the packed items verbatim', () => {
    const edited: ImportConfirmItem = { path: '/b', title: 'Edited Title', authorName: 'Edited Author', forceImport: true };
    const { chunks } = packConfirmChunks([edited]);
    expect(chunks[0]![0]).toEqual(edited);
  });

  it('returns no chunks when every item is self-oversize', () => {
    const huge = itemOfSize('/huge', MAX_SINGLE_ITEM_BYTES + 1024);
    const { chunks, tooLarge } = packConfirmChunks([huge]);
    expect(chunks).toHaveLength(0);
    expect(tooLarge).toHaveLength(1);
  });

  // Byte-vs-character accounting: every fixture above is ASCII (chars == bytes), so a
  // TextEncoder → .length regression would pass the whole suite while undercounting
  // multi-byte metadata up to 4× and breaching the 1 MiB floor. 'あ' is 1 JS char / 3 UTF-8 bytes.
  it('diverts a multi-byte item whose UTF-8 bytes exceed the ceiling even though its char count does not', () => {
    // 310k chars ≈ 930 KiB serialized > 900 KiB ceiling; a char-count accounting would pass it.
    const item = { path: '/utf8', title: 'T', metadata: { blob: 'あ'.repeat(310 * 1024) } as never };
    expect(serializedItemBytes(item)).toBeGreaterThan(MAX_SINGLE_ITEM_BYTES);
    const { chunks, tooLarge } = packConfirmChunks([item]);
    expect(tooLarge).toHaveLength(1);
    expect(chunks).toHaveLength(0);
  });

  it('splits multi-byte items by UTF-8 byte budget even when combined char count is under it', () => {
    // Two items each ~240 KiB serialized (80k 3-byte chars) → 480 KiB > 400 KiB budget → 2 chunks.
    // Char-count accounting (~160k total) would pack them together.
    const mk = (p: string) => ({ path: p, title: 'T', metadata: { blob: 'あ'.repeat(80 * 1024) } as never });
    const { chunks } = packConfirmChunks([mk('/a'), mk('/b')]);
    expect(chunks).toHaveLength(2);
  });

  // Exactly-at-threshold boundaries: a flipped > vs >= would silently ship.
  it('ships an item at exactly MAX_SINGLE_ITEM_BYTES; one byte over diverts (ceiling is inclusive)', () => {
    const exact = itemOfSize('/exact', MAX_SINGLE_ITEM_BYTES);
    expect(serializedItemBytes(exact)).toBe(MAX_SINGLE_ITEM_BYTES);
    const atCeiling = packConfirmChunks([exact]);
    expect(atCeiling.tooLarge).toHaveLength(0);
    expect(atCeiling.chunks).toEqual([[exact]]);

    const over = itemOfSize('/over', MAX_SINGLE_ITEM_BYTES + 1);
    const overCeiling = packConfirmChunks([over]);
    expect(overCeiling.tooLarge).toHaveLength(1);
    expect(overCeiling.chunks).toHaveLength(0);
  });

  it('packs items summing to exactly CHUNK_BYTE_BUDGET into one chunk; one byte more splits', () => {
    const half = itemOfSize('/h1', CHUNK_BYTE_BUDGET / 2);
    expect(serializedItemBytes(half)).toBe(CHUNK_BYTE_BUDGET / 2);
    expect(packConfirmChunks([half, itemOfSize('/h2', CHUNK_BYTE_BUDGET / 2)]).chunks).toHaveLength(1);
    expect(packConfirmChunks([half, itemOfSize('/h3', CHUNK_BYTE_BUDGET / 2 + 1)]).chunks).toHaveLength(2);
  });
});
