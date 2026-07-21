import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportConfirmItem, type ImportMode, type HeldReviewItem, type SubmissionResponse, type StagedItemResultDto } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { SubmissionSource } from '../../../core/import-staging/schemas.js';
import { classifySubmission } from './classify.js';
import { preflightSubmission, PREFLIGHT_COPY } from './preflight.js';
import { computeSubmissionDigest } from './digest.js';
import { generateClientSubmissionId, EntropyUnavailableError } from './client-uuid.js';
import { runSubmit, SubmitError } from './submit-flow.js';
import { createPollController, type PollController } from './poll.js';
import { reconcileByClient } from './reconcile.js';
import { readOutbox, putOutbox, markOutboxFinalized, evictOutbox, type OutboxRecord } from './outbox.js';
import { STAGED_COPY, type StagedBannerKey } from './messages.js';
import { buildStagedOutcomeToast, isCleanCompletion, type LocalExclusions } from './outcome.js';

/**
 * Staged-import submit + poll orchestrator (#1902). Wires the built staged modules —
 * classify → preflight → digest/UUID → create/PUT/finalize (`runSubmit`) → summary
 * poll → one-time terminal detail (`createPollController`) → count-driven
 * outcome/navigation/deselect — plus the source-scoped best-effort outbox hint and
 * mount `by-client` reconciliation. Both import page hooks call `submit()` (fresh
 * import AND held re-confirm) and read the returned lifecycle state; all the transport
 * error dispositions, single-flight polling, and outbox transitions live here so the
 * page hooks stay thin.
 */

export interface StagedProgress {
  current: number;
  total: number;
  chunks: number;
}

export interface UseStagedSubmissionParams {
  source: SubmissionSource;
  /** The page's word for an accepted item — "registered" / "queued for import". */
  acceptedVerb: string;
  /** In-session clean completion → navigate away (the page passes `() => navigate('/library')`). */
  onCleanNavigate: () => void;
  /** Deselect the accepted rows in place after a partial (server or local) outcome. */
  onDeselectAccepted: (acceptedPaths: Set<string>) => void;
  /** Surface held rows for re-confirm; `mode` is the confirm-attempt snapshot. */
  captureHeld: (items: HeldReviewItem[], mode: ImportMode | undefined) => void;
  clearHeld: () => void;
}

export interface UseStagedSubmission {
  /** Run the full staged pipeline over the selected rows (or held re-confirm rows). */
  submit: (items: ImportConfirmItem[], mode: ImportMode | undefined) => void;
  /** True from submit start through the terminal detail projection (button-disabling). */
  isPending: boolean;
  /** Upload/registration progress → "Registering X of Y…". */
  chunkProgress: StagedProgress | null;
  /** Pinned recoverable/error/preflight copy, or null. */
  banner: string | null;
  dismissBanner: () => void;
}

/** Map a detail-DTO held row to the shared `HeldReviewItem` shape (path/title survive nulling). */
function toHeldReviewItem(row: Extract<StagedItemResultDto, { disposition: 'held' }>): HeldReviewItem {
  return {
    path: row.path,
    title: row.title,
    reason: 'recording-review-required',
    ...(row.existingBookId !== undefined ? { existingBookId: row.existingBookId } : {}),
  };
}

/** Paths of the rows the server accepted (from the detail projection). */
function acceptedPathsFromDetail(detail: SubmissionResponse): Set<string> {
  if (!('items' in detail) || !detail.items) return new Set();
  return new Set(detail.items.filter((i) => i.disposition === 'accepted').map((i) => i.path));
}

// eslint-disable-next-line max-lines-per-function -- one cohesive submit/poll/reconcile lifecycle; splitting it would scatter shared refs
export function useStagedSubmission(params: UseStagedSubmissionParams): UseStagedSubmission {
  const { source, acceptedVerb, onCleanNavigate, onDeselectAccepted, captureHeld, clearHeld } = params;
  const queryClient = useQueryClient();

  const [isPending, setIsPending] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<StagedProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Per-submission scratch that must survive re-renders without re-triggering effects.
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<PollController | null>(null);
  const localExclusionsRef = useRef<LocalExclusions>({ invalid: 0, oversize: 0 });
  const modeRef = useRef<ImportMode | undefined>(undefined);
  const chunkCountRef = useRef(1);

  const invalidateReportReads = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.importSubmissions.root() });
  }, [queryClient]);

  const stopPoll = useCallback(() => {
    pollRef.current?.stop();
    pollRef.current = null;
  }, []);

  // ── Terminal detail projection → count-driven outcome / navigation / deselect ──
  const projectOutcome = useCallback(
    (detail: SubmissionResponse, recovered: boolean) => {
      setIsPending(false);
      setChunkProgress(null);
      // A completion recovered on remount has no surviving in-session summary (F29).
      const local: LocalExclusions = recovered ? { invalid: 0, oversize: 0 } : localExclusionsRef.current;
      const agg = detail.aggregates;

      // Held rows drive their own recovery panel — only when the per-row detail survived (F29).
      if (!detail.detailsPruned && 'items' in detail && detail.items) {
        const held = detail.items.filter((i): i is Extract<StagedItemResultDto, { disposition: 'held' }> => i.disposition === 'held');
        if (held.length > 0) {
          captureHeld(held.map(toHeldReviewItem), recovered ? undefined : modeRef.current);
          toast.warning(`${held.length} held for recording review`);
        } else if (!recovered) {
          clearHeld();
        }
      }

      const outcome = buildStagedOutcomeToast(agg, local, acceptedVerb);
      if (outcome) toast[outcome.severity](outcome.message);

      // The accepted rows changed the library — refresh books + the #1894 report reads.
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      invalidateReportReads();

      evictOutbox(source);

      // Clean AND in-session → navigate; any partial (server or local), or a recovered
      // completion, stays in place and deselects the accepted rows.
      if (!recovered && isCleanCompletion(agg, local)) {
        onCleanNavigate();
        return;
      }
      const acceptedPaths = acceptedPathsFromDetail(detail);
      if (acceptedPaths.size > 0) onDeselectAccepted(acceptedPaths);
    },
    [acceptedVerb, captureHeld, clearHeld, invalidateReportReads, onCleanNavigate, onDeselectAccepted, queryClient, source],
  );

  const startPoll = useCallback(
    (submissionId: number, recovered: boolean) => {
      stopPoll();
      const controller = createPollController({
        api,
        submissionId,
        onSummary: (summary) => {
          if (summary.expectedCount > 0) {
            setChunkProgress({ current: summary.processedCount, total: summary.expectedCount, chunks: Math.max(2, chunkCountRef.current) });
          }
        },
        onComplete: (detail) => projectOutcome(detail, recovered),
        onBanner: (key: StagedBannerKey) => {
          setBanner(STAGED_COPY[key]);
          setIsPending(false);
          setChunkProgress(null);
        },
        onEvictHint: () => evictOutbox(source),
      });
      pollRef.current = controller;
      controller.start();
    },
    [projectOutcome, source, stopPoll],
  );

  // ── SubmitError disposition → banner + outbox transition ──────────────────────
  const handleSubmitError = useCallback(
    (error: SubmitError) => {
      setIsPending(false);
      setChunkProgress(null);
      switch (error.disposition) {
        case 'aborted':
          return; // unmount/navigation — surface nothing
        case 'create-unreachable':
        case 'finalize-unreachable':
          setBanner(STAGED_COPY.createUnreachable); // hint retained → next mount probes by-client
          return;
        case 'digest-conflict':
          setBanner(STAGED_COPY.digestConflict); // durable header left recoverable; fresh UUID on retry
          return;
        case 'put-failed':
          setBanner(STAGED_COPY.createUnreachable); // upload stopped; receiving header inert, hint left for reconcile
          return;
        case 'create-invalid':
        case 'finalize-failed':
          setBanner(STAGED_COPY.createUnreachable);
          evictOutbox(source);
          return;
        case 'finalize-invariant':
          setBanner(STAGED_COPY.finalizeInvariant);
          evictOutbox(source);
          return;
        case 'finalize-missing':
          evictOutbox(source); // never landed — safe re-run, no error banner
          return;
      }
    },
    [source],
  );

  const runPipeline = useCallback(
    async (survivorItems: Parameters<typeof runSubmit>[0]['items'], clientSubmissionId: string, payloadDigest: string, mode: ImportMode | undefined) => {
      const abort = new AbortController();
      abortRef.current = abort;
      const outboxRecord: OutboxRecord = {
        version: 1,
        clientSubmissionId,
        source,
        status: 'submitting',
        payloadDigest,
        expectedCount: survivorItems.length,
      };
      putOutbox(outboxRecord);

      try {
        const { submissionId } = await runSubmit({
          api,
          source,
          ...(source === 'manual' && mode !== undefined ? { mode } : {}),
          items: survivorItems,
          clientSubmissionId,
          payloadDigest,
          signal: abort.signal,
          onChunkProgress: (p) => {
            chunkCountRef.current = p.chunks;
            setChunkProgress(p);
          },
          onCreated: () => invalidateReportReads(),
        });
        markOutboxFinalized(source, submissionId);
        startPoll(submissionId, false);
      } catch (error) {
        if (error instanceof SubmitError) handleSubmitError(error);
        else setBanner(STAGED_COPY.createUnreachable);
      }
    },
    [handleSubmitError, invalidateReportReads, source, startPoll],
  );

  const submit = useCallback(
    (items: ImportConfirmItem[], mode: ImportMode | undefined) => {
      setBanner(null);
      modeRef.current = mode;

      const classified = classifySubmission(items);
      localExclusionsRef.current = { invalid: classified.invalidCount, oversize: classified.oversizeCount };

      const gate = preflightSubmission(classified.survivors);
      if (gate.kind !== 'ok') {
        // No UUID / hint / create; rows stay selected. Only the first tripped gate's copy shows.
        if (gate.kind === 'zero-survivors') {
          const parts: string[] = [];
          if (classified.invalidCount > 0) parts.push(`${classified.invalidCount} couldn’t be prepared — check their details`);
          if (classified.oversizeCount > 0) parts.push(`${classified.oversizeCount} too large to submit — remove or re-scan`);
          setBanner(parts.join(' · ') || 'Nothing to import — every selected book was excluded');
        } else if (gate.kind === 'row-count') {
          setBanner(PREFLIGHT_COPY.rowCount);
        } else {
          setBanner(PREFLIGHT_COPY.byteBudget);
        }
        return;
      }

      setIsPending(true);
      setChunkProgress(null);
      chunkCountRef.current = 1;
      const items$ = classified.survivors;
      const digestInput = { source, ...(source === 'manual' && mode !== undefined ? { mode } : {}), items: [...items$] };
      let clientSubmissionId: string;
      try {
        clientSubmissionId = generateClientSubmissionId();
      } catch (error) {
        setIsPending(false);
        setBanner(error instanceof EntropyUnavailableError ? error.message : STAGED_COPY.createUnreachable);
        return;
      }
      void computeSubmissionDigest(digestInput).then((payloadDigest) => runPipeline(items$, clientSubmissionId, payloadDigest, mode));
    },
    [runPipeline, source],
  );

  const dismissBanner = useCallback(() => setBanner(null), []);

  // ── Mount reconciliation via the source-scoped outbox hint (by-client) ────────
  useEffect(() => {
    const record = readOutbox(source);
    if (!record) return;
    const abort = new AbortController();
    void (async () => {
      const result = await reconcileByClient({ api, clientSubmissionId: record.clientSubmissionId, signal: abort.signal });
      if (abort.signal.aborted) return;
      switch (result.action) {
        case 'rejoin':
          startPoll(result.submissionId, true);
          break;
        case 'evict':
          evictOutbox(source);
          break;
        case 'lookup-failed':
          setBanner(STAGED_COPY.createUnreachable); // pointer retained
          break;
        case 'aborted':
          break;
      }
    })();
    return () => abort.abort();
    // Run once per source on mount; deliberately not re-run on startPoll identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Abort any in-flight submit + stop polling on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      pollRef.current?.stop();
    };
  }, []);

  return { submit, isPending, chunkProgress, banner, dismissBanner };
}
