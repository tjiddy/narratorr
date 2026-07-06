import { describe, it, expect, vi } from 'vitest';
import { runChunkedConfirm } from './confirm-chunk-runner.js';
import { serializedItemBytes, MAX_SINGLE_ITEM_BYTES } from './confirm-chunks.js';
import type { ImportConfirmItem, ImportMode, ImportResult } from '@/lib/api';

/** Signature of the runner's `confirm` param — used to type each mock. */
type ConfirmFn = (items: ImportConfirmItem[], mode: ImportMode | undefined) => Promise<ImportResult>;

/** Each item is padded above the chunk byte budget, so 1 item ⇒ 1 chunk (predictable boundaries). */
function bigItem(path: string, bytes = 500 * 1024): ImportConfirmItem {
  const base: ImportConfirmItem = { path, title: 'T', metadata: { blob: '' } as never };
  const pad = Math.max(0, bytes - serializedItemBytes(base));
  return { path, title: 'T', metadata: { blob: 'x'.repeat(pad) } as never };
}

const ok = (n: number): ImportResult => ({ accepted: n, heldReview: [], skipped: [], failed: [] });

describe('runChunkedConfirm (#1831)', () => {
  it('resolves with a concatenated aggregate over all chunks on full success', async () => {
    const items = [bigItem('/a'), bigItem('/b'), bigItem('/c')];
    const confirm = vi.fn<ConfirmFn>(async (chunk) => ({
      accepted: chunk.length,
      heldReview: [{ path: chunk[0]!.path, title: 'H', reason: 'recording-review-required' as const }],
      skipped: [],
      failed: [],
    }));

    const res = await runChunkedConfirm({ items, mode: undefined, confirm });

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(res.aggregateResult.accepted).toBe(3);
    expect(res.aggregateResult.heldReview.map(h => h.path)).toEqual(['/a', '/b', '/c']);
    expect(res.submittedItems.map(i => i.path)).toEqual(['/a', '/b', '/c']);
    expect(res.unsubmitted).toEqual({ count: 0, inFlight: 0, remainder: 0, reason: null });
    expect(res.tooLarge.count).toBe(0);
  });

  it('threads mode to every chunk and reports progress across the run', async () => {
    const items = [bigItem('/a'), bigItem('/b')];
    const confirm = vi.fn<ConfirmFn>(async (chunk) => ok(chunk.length));
    const onProgress = vi.fn();

    await runChunkedConfirm({ items, mode: 'move', confirm, onProgress });

    expect(confirm).toHaveBeenNthCalledWith(1, expect.any(Array), 'move');
    expect(confirm).toHaveBeenNthCalledWith(2, expect.any(Array), 'move');
    // Final progress reports both items submitted of the total, across 2 chunks.
    expect(onProgress).toHaveBeenLastCalledWith({ current: 2, total: 2, chunks: 2 });
  });

  it('mid-sequence failure returns submittedItems + the in-flight/remainder split', async () => {
    const items = [bigItem('/a'), bigItem('/b'), bigItem('/c'), bigItem('/d'), bigItem('/e')];
    let call = 0;
    const confirm = vi.fn<ConfirmFn>(async (chunk) => {
      call += 1;
      if (call === 3) throw new Error('connection reset');
      return ok(chunk.length);
    });

    const res = await runChunkedConfirm({ items, mode: undefined, confirm });

    // Chunks 1–2 applied; chunk 3 in-flight; chunks 4–5 never sent.
    expect(res.aggregateResult.accepted).toBe(2);
    expect(res.submittedItems.map(i => i.path)).toEqual(['/a', '/b']);
    expect(res.unsubmitted).toEqual({ count: 3, inFlight: 1, remainder: 2, reason: 'connection reset' });
    expect(res.tooLarge.count).toBe(0);
  });

  it('rejects on a first-chunk failure with nothing submitted and no tooLarge rows', async () => {
    const items = [bigItem('/a'), bigItem('/b')];
    const confirm = vi.fn<ConfirmFn>(async () => { throw new Error('boom'); });

    await expect(runChunkedConfirm({ items, mode: undefined, confirm })).rejects.toThrow('boom');
  });

  it('resolves (does not reject) when a self-oversize item is present even with a first-chunk failure', async () => {
    const items = [bigItem('/huge', MAX_SINGLE_ITEM_BYTES + 50 * 1024), bigItem('/a')];
    const confirm = vi.fn<ConfirmFn>(async () => { throw new Error('boom'); });

    const res = await runChunkedConfirm({ items, mode: undefined, confirm });

    expect(res.tooLarge.count).toBe(1);
    expect(res.submittedItems).toHaveLength(0);
    expect(res.unsubmitted.count).toBe(1); // the one non-oversize chunk was in-flight when it failed
  });

  it('resolves with only tooLarge when every item is self-oversize (never calls confirm)', async () => {
    const items = [bigItem('/huge', MAX_SINGLE_ITEM_BYTES + 50 * 1024)];
    const confirm = vi.fn<ConfirmFn>(async () => ok(1));

    const res = await runChunkedConfirm({ items, mode: undefined, confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(res.tooLarge.count).toBe(1);
    expect(res.submittedItems).toHaveLength(0);
    expect(res.unsubmitted.count).toBe(0);
  });
});

