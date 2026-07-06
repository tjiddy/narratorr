import type { ImportConfirmItem, ImportMode, ImportResult } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { packConfirmChunks } from './confirm-chunks.js';

/**
 * Sequential chunk runner for the confirm POST (#1831). Packs the selected items
 * (see {@link packConfirmChunks}), diverts self-oversize rows to `tooLarge`, and
 * POSTs each chunk one at a time to the unchanged confirm endpoint — the server is
 * already chunk-safe (per-item, DB-backed dedup; a resubmitted accepted item
 * re-classifies as skipped).
 *
 * Contract (the part where the naive version breaks #1822): this RESOLVES (never
 * rejects) once ≥1 chunk has succeeded OR any row was diverted to `tooLarge`,
 * returning the aggregate plus the *actually-submitted* items so the caller can
 * compute accepted/held/deselection over `submittedItems` — NOT the full selection,
 * which would misclassify the never-sent remainder as accepted and silently
 * deselect it. Only a first-chunk failure with nothing submitted and no `tooLarge`
 * rows rejects, into the caller's existing `onError` path unchanged.
 */
export interface ChunkedConfirmResult {
  /** Per-chunk `accepted`/`heldReview`/`skipped`/`failed` concatenated across submitted chunks. */
  aggregateResult: ImportResult;
  /** Items from chunks that received a response — the basis for accepted/deselection semantics. */
  submittedItems: ImportConfirmItem[];
  /**
   * Items that did not land. `inFlight` is the failing chunk (attempted, unconfirmed —
   * resubmit-safe); `remainder` is the never-sent chunks after it; `count` is their sum.
   * `reason` carries the transport error message (null on a fully-submitted run). The
   * in-flight/remainder split lets the toast name both, which the base `{ count, reason }`
   * shape cannot express.
   */
  unsubmitted: { count: number; inFlight: number; remainder: number; reason: string | null };
  /** Rows diverted pre-flight because their own serialized size exceeds the transport ceiling. */
  tooLarge: { count: number };
}

export interface RunChunkedConfirmParams {
  items: ImportConfirmItem[];
  /** Threaded to every chunk so manual-import's per-attempt mode snapshot (#1732) is preserved. */
  mode: ImportMode | undefined;
  confirm: (items: ImportConfirmItem[], mode: ImportMode | undefined) => Promise<ImportResult>;
  /** Progress across the sequential run — drives the "Registering X of Y…" label. */
  onProgress?: (progress: { current: number; total: number }) => void;
}

const emptyResult = (): ImportResult => ({ accepted: 0, heldReview: [], skipped: [], failed: [] });

export async function runChunkedConfirm(params: RunChunkedConfirmParams): Promise<ChunkedConfirmResult> {
  const { items, mode, confirm, onProgress } = params;
  const { chunks, tooLarge } = packConfirmChunks(items);

  const aggregate = emptyResult();
  const submittedItems: ImportConfirmItem[] = [];
  const total = chunks.reduce((n, c) => n + c.length, 0);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    onProgress?.({ current: submittedItems.length, total });

    let result: ImportResult;
    try {
      result = await confirm(chunk, mode);
    } catch (error: unknown) {
      // First-chunk failure with nothing to report → reject into the existing onError path.
      if (submittedItems.length === 0 && tooLarge.length === 0) throw error;
      // Otherwise resolve with the partial outcome, splitting the failing (in-flight) chunk
      // from the never-sent remainder so the toast can name both.
      const remainder = chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
      return {
        aggregateResult: aggregate,
        submittedItems,
        unsubmitted: { count: chunk.length + remainder, inFlight: chunk.length, remainder, reason: getErrorMessage(error) },
        tooLarge: { count: tooLarge.length },
      };
    }

    submittedItems.push(...chunk);
    aggregate.accepted += result.accepted;
    aggregate.heldReview.push(...result.heldReview);
    aggregate.skipped.push(...result.skipped);
    aggregate.failed.push(...result.failed);
  }

  onProgress?.({ current: submittedItems.length, total });
  return {
    aggregateResult: aggregate,
    submittedItems,
    unsubmitted: { count: 0, inFlight: 0, remainder: 0, reason: null },
    tooLarge: { count: tooLarge.length },
  };
}
