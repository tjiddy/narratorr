import { ApiError } from '@/lib/api';
import type { ImportConfirmItem, ImportMode, ImportResult } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { packConfirmChunks } from './confirm-chunks.js';

/**
 * Why a mid-run chunk did not land (#1833). `'transport'` is a network-level failure
 * (connection reset) — the chunk was attempted, its fate is unknown, and resubmitting is
 * safe (the server re-classifies an already-accepted item as skipped). `'too-large'` is a
 * deterministic 413 (Fastify body limit or, more often, a proxy hop with a sub-900 KiB
 * `client_max_body_size`) — it will fail identically on every retry, so the toast must NOT
 * claim resubmitting is safe. `null` on a fully-submitted run.
 */
export type UnsubmittedReasonKind = 'transport' | 'too-large' | null;

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
   * `reason` carries the transport error message (null on a fully-submitted run);
   * `reasonKind` discriminates a deterministic 413 (`'too-large'`) from a retryable
   * transport failure (`'transport'`) so the toast can drop the false "resubmitting is
   * safe" claim for the too-large case (#1833). The in-flight/remainder split lets the
   * toast name both, which the base `{ count, reason }` shape cannot express.
   */
  unsubmitted: { count: number; inFlight: number; remainder: number; reason: string | null; reasonKind: UnsubmittedReasonKind };
  /** Rows diverted pre-flight because their own serialized size exceeds the transport ceiling. */
  tooLarge: { count: number };
}

export interface RunChunkedConfirmParams {
  items: ImportConfirmItem[];
  /** Threaded to every chunk so manual-import's per-attempt mode snapshot (#1732) is preserved. */
  mode: ImportMode | undefined;
  confirm: (items: ImportConfirmItem[], mode: ImportMode | undefined) => Promise<ImportResult>;
  /**
   * Progress across the sequential run — drives the "Registering X of Y…" label.
   * `chunks` is the number of requests the run splits into; the UI only surfaces the
   * label for a genuinely multi-chunk run (a single-chunk import keeps "Importing…").
   */
  onProgress?: (progress: { current: number; total: number; chunks: number }) => void;
}

const emptyResult = (): ImportResult => ({ accepted: 0, heldReview: [], skipped: [], failed: [] });

export async function runChunkedConfirm(params: RunChunkedConfirmParams): Promise<ChunkedConfirmResult> {
  const { items, mode, confirm, onProgress } = params;
  // An empty selection has nothing to POST. The old single-request path 400ed server-side;
  // resolving as a clean empty result here would fire a phantom green toast + navigate away
  // with no server call (#1833). Reject so the caller's onError path handles it — the UI
  // gates the Import button on a non-empty selection, so this is a defensive guard.
  if (items.length === 0) throw new Error('No books selected to import.');
  const { chunks, tooLarge } = packConfirmChunks(items);

  const aggregate = emptyResult();
  const submittedItems: ImportConfirmItem[] = [];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const chunkCount = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    // Report items-ATTEMPTED (previously-submitted + this in-flight chunk) so the first chunk
    // renders "Registering N of M" while POSTing, never a stalled "0 of M" (#1833).
    onProgress?.({ current: submittedItems.length + chunk.length, total, chunks: chunkCount });

    let result: ImportResult;
    try {
      result = await confirm(chunk, mode);
    } catch (error: unknown) {
      // First-chunk failure with nothing to report → reject into the existing onError path.
      if (submittedItems.length === 0 && tooLarge.length === 0) throw error;
      // Otherwise resolve with the partial outcome, splitting the failing (in-flight) chunk
      // from the never-sent remainder so the toast can name both. Preserve error identity: a
      // 413 is deterministic (too-large), a network reset is retryable (transport) — the toast
      // wording branches on this (#1833).
      const remainder = chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
      const reasonKind: UnsubmittedReasonKind = error instanceof ApiError && error.status === 413 ? 'too-large' : 'transport';
      return {
        aggregateResult: aggregate,
        submittedItems,
        unsubmitted: { count: chunk.length + remainder, inFlight: chunk.length, remainder, reason: getErrorMessage(error), reasonKind },
        tooLarge: { count: tooLarge.length },
      };
    }

    submittedItems.push(...chunk);
    aggregate.accepted += result.accepted;
    aggregate.heldReview.push(...result.heldReview);
    aggregate.skipped.push(...result.skipped);
    aggregate.failed.push(...result.failed);
  }

  onProgress?.({ current: submittedItems.length, total, chunks: chunkCount });
  return {
    aggregateResult: aggregate,
    submittedItems,
    unsubmitted: { count: 0, inFlight: 0, remainder: 0, reason: null, reasonKind: null },
    tooLarge: { count: tooLarge.length },
  };
}
