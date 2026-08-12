import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportConfirmItem, type ImportMode, type HeldReviewItem, type SubmissionResponse, type StagedItemResultDto } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { SubmissionSource } from '@core/import-staging/schemas.js';
import { classifySubmission } from './classify.js';
import { preflightSubmission, PREFLIGHT_COPY } from './preflight.js';
import { computeSubmissionDigest } from './digest.js';
import { generateClientSubmissionId, EntropyUnavailableError } from './client-uuid.js';
import { runSubmit, SubmitError } from './submit-flow.js';
import { createPollController, type PollController } from './poll.js';
import { reconcileByClient } from './reconcile.js';
import { readOutbox, putOutbox, markOutboxFinalized, evictOutbox, type OutboxRecord } from './outbox.js';
import { STAGED_COPY, putFailedWithCounts, type StagedBannerKey } from './messages.js';
import { buildStagedOutcomeToast, isCleanCompletion, type LocalExclusions } from './outcome.js';
import { acceptedItemPaths } from '@/lib/import-outcome.js';

// Orchestrates preflight, durable submission, polling, recovery, and terminal UI policy.

export interface StagedProgress {
  current: number;
  total: number;
  chunks: number;
}

export interface UseStagedSubmissionParams {
  source: SubmissionSource;
  /** The page's word for an accepted item — "registered" / "queued for import". */
  acceptedVerb: string;
  onCleanNavigate: () => void;
  /** Deselect accepted paths for in-session partial outcomes or clean runs that stay on-page. */
  onDeselectAccepted: (acceptedPaths: ReadonlySet<string>) => void;
  captureHeld: (items: HeldReviewItem[], mode: ImportMode | undefined) => void;
  clearHeld: () => void;
  /** Snapshotted after preflight; true keeps clean completion on-page and deselects submitted rows. */
  shouldStayOnClean?: () => boolean;
}

export interface UseStagedSubmission {
  submit: (items: ImportConfirmItem[], mode: ImportMode | undefined) => void;
  isPending: boolean;
  chunkProgress: StagedProgress | null;
  banner: string | null;
  dismissBanner: () => void;
}

function toHeldReviewItem(row: Extract<StagedItemResultDto, { disposition: 'held' }>): HeldReviewItem {
  return {
    path: row.path,
    title: row.title,
    reason: 'recording-review-required',
    ...(row.existingBookId !== undefined ? { existingBookId: row.existingBookId } : {}),
  };
}

// eslint-disable-next-line max-lines-per-function -- one cohesive submit/poll/reconcile lifecycle; splitting it would scatter shared refs
export function useStagedSubmission(params: UseStagedSubmissionParams): UseStagedSubmission {
  const { source, acceptedVerb, onCleanNavigate, onDeselectAccepted, captureHeld, clearHeld, shouldStayOnClean } = params;
  const queryClient = useQueryClient();

  const [isPending, setIsPending] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<StagedProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountAbortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<PollController | null>(null);
  const localExclusionsRef = useRef<LocalExclusions>({ invalid: 0, oversize: 0 });
  const modeRef = useRef<ImportMode | undefined>(undefined);
  const chunkCountRef = useRef(1);
  // Recovered receipts must never deselect a remounted page's current selection.
  const submittedPathsRef = useRef<ReadonlySet<string>>(new Set());
  // Failed preflight and later pause changes cannot alter an accepted run's terminal policy.
  const stayOnCleanRef = useRef(false);
  // Every async callback checks this epoch; newer submits supersede old work.
  const runEpochRef = useRef(0);

  const invalidateReportReads = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.importSubmissions.root() });
  }, [queryClient]);

  const stopPoll = useCallback(() => {
    pollRef.current?.stop();
    pollRef.current = null;
  }, []);

  // Clean "stay" deselects the frozen run; partial deselects accepted items from that run.
  const applyTerminalSelection = useCallback(
    (clean: boolean, items: readonly StagedItemResultDto[] | undefined) => {
      if (clean) {
        if (!stayOnCleanRef.current) return onCleanNavigate();
        if (submittedPathsRef.current.size > 0) onDeselectAccepted(submittedPathsRef.current);
        return;
      }
      const acceptedDto = items ? acceptedItemPaths(items) : new Set<string>();
      const acceptedPaths = new Set([...acceptedDto].filter((p) => submittedPathsRef.current.has(p)));
      if (acceptedPaths.size > 0) onDeselectAccepted(acceptedPaths);
    },
    [onCleanNavigate, onDeselectAccepted],
  );

  const projectOutcome = useCallback(
    (detail: SubmissionResponse, recovered: boolean, clientSubmissionId: string) => {
      setIsPending(false);
      setChunkProgress(null);
      // Remount recovery has no surviving in-session exclusion counts.
      const local: LocalExclusions = recovered ? { invalid: 0, oversize: 0 } : localExclusionsRef.current;
      const agg = detail.aggregates;
      const items = !detail.detailsPruned && 'items' in detail && detail.items ? detail.items : undefined;

      // Recovered held rows stay read-only because their confirmation mode did not survive reload.
      if (items) {
        const held = items.filter((i): i is Extract<StagedItemResultDto, { disposition: 'held' }> => i.disposition === 'held');
        if (held.length > 0) {
          if (!recovered) captureHeld(held.map(toHeldReviewItem), modeRef.current);
          toast.warning(`${held.length} held for recording review`);
        } else if (!recovered) {
          clearHeld();
        }
      }

      const skippedRows = items
        ?.filter((i): i is Extract<StagedItemResultDto, { disposition: 'skipped' }> => i.disposition === 'skipped')
        .map((i) => ({ reason: i.reason, ...(i.existingTitle !== undefined ? { existingTitle: i.existingTitle } : {}) }));
      const outcome = buildStagedOutcomeToast(agg, local, acceptedVerb, skippedRows);
      if (outcome) toast[outcome.severity](outcome.message);

      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      invalidateReportReads();

      // Client ID prevents evicting a newer outbox slot.
      evictOutbox(source, clientSubmissionId);

      // Recovery never navigates or deselects because this page may show another session's rows.
      if (recovered) return;
      applyTerminalSelection(isCleanCompletion(agg, local), items);
    },
    [acceptedVerb, applyTerminalSelection, captureHeld, clearHeld, invalidateReportReads, queryClient, source],
  );

  const startPoll = useCallback(
    (submissionId: number, recovered: boolean, clientSubmissionId: string, epoch: number) => {
      // A stale start request must not stop the current run's poll.
      if (epoch !== runEpochRef.current) return;
      const isCurrent = () => epoch === runEpochRef.current;
      stopPoll();
      const controller = createPollController({
        api,
        submissionId,
        onSummary: (summary) => {
          if (!isCurrent()) return;
          if (summary.expectedCount > 0) {
            setChunkProgress({ current: summary.processedCount, total: summary.expectedCount, chunks: Math.max(2, chunkCountRef.current) });
          }
        },
        onComplete: (detail) => {
          if (!isCurrent()) return;
          projectOutcome(detail, recovered, clientSubmissionId);
        },
        onBanner: (key: StagedBannerKey) => {
          if (!isCurrent()) return;
          setBanner(STAGED_COPY[key]);
          setIsPending(false);
          setChunkProgress(null);
        },
        onEvictHint: () => evictOutbox(source, clientSubmissionId),
      });
      pollRef.current = controller;
      controller.start();
    },
    [projectOutcome, source, stopPoll],
  );

  // A lost finalize response may have landed; rejoin by client ID before allowing retry.
  const recoverInSessionByClient = useCallback(
    async (clientSubmissionId: string, signal: AbortSignal, epoch: number) => {
      const result = await reconcileByClient({ api, clientSubmissionId, signal });
      if (signal.aborted || epoch !== runEpochRef.current) return;
      switch (result.action) {
        case 'rejoin':
          startPoll(result.submissionId, false, clientSubmissionId, epoch);
          return;
        case 'evict':
          setIsPending(false);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'lookup-failed':
          setIsPending(false);
          setBanner(STAGED_COPY.createUnreachable); // Keep the hint for mount recovery.
          return;
        case 'aborted':
          return;
      }
    },
    [source, startPoll],
  );

  const handleSubmitError = useCallback(
    (error: SubmitError, clientSubmissionId: string) => {
      setIsPending(false);
      setChunkProgress(null);
      switch (error.disposition) {
        case 'aborted':
          return;
        case 'create-unreachable':
          setBanner(STAGED_COPY.createUnreachable); // Keep the hint for mount recovery.
          return;
        case 'digest-conflict':
          setBanner(STAGED_COPY.digestConflict); // Keep the recoverable header; retry uses a fresh UUID.
          return;
        case 'put-failed':
          // Permanent upload rejection; keep the receiving hint for mount reconciliation.
          setBanner(error.counts ? putFailedWithCounts(error.counts.received, error.counts.total) : STAGED_COPY.putFailed);
          return;
        case 'create-invalid':
          setBanner(STAGED_COPY.createInvalid);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-failed':
          setBanner(STAGED_COPY.finalizeFailed);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-invariant':
          setBanner(STAGED_COPY.finalizeInvariant);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-missing':
          evictOutbox(source, clientSubmissionId); // Never landed; safe to retry without a banner.
          return;
        case 'finalize-unreachable':
          return; // Handled by in-session recovery.
      }
    },
    [source],
  );

  const runPipeline = useCallback(
    async (survivorItems: Parameters<typeof runSubmit>[0]['items'], clientSubmissionId: string, payloadDigest: string, mode: ImportMode | undefined, epoch: number, abort: AbortController) => {
      // Newer submits and unmounts revoke this run's right to publish.
      const isCurrent = () => epoch === runEpochRef.current && !abort.signal.aborted;
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
            if (!isCurrent()) return;
            chunkCountRef.current = p.chunks;
            setChunkProgress(p);
          },
          onCreated: () => {
            if (isCurrent()) invalidateReportReads();
          },
        });
        if (!isCurrent()) return;
        markOutboxFinalized(source, submissionId, clientSubmissionId);
        startPoll(submissionId, false, clientSubmissionId, epoch);
      } catch (error: unknown) {
        if (!isCurrent()) return;
        if (error instanceof SubmitError) {
          // Finalize may have landed despite the transport error.
          if (error.disposition === 'finalize-unreachable') {
            await recoverInSessionByClient(clientSubmissionId, abort.signal, epoch);
            return;
          }
          handleSubmitError(error, clientSubmissionId);
        } else {
          setIsPending(false);
          setBanner(STAGED_COPY.createUnreachable);
        }
      }
    },
    [handleSubmitError, invalidateReportReads, recoverInSessionByClient, source, startPoll],
  );

  const submit = useCallback(
    (items: ImportConfirmItem[], mode: ImportMode | undefined) => {
      setBanner(null);
      modeRef.current = mode;

      const classified = classifySubmission(items);
      localExclusionsRef.current = { invalid: classified.invalidCount, oversize: classified.oversizeCount };

      const gate = preflightSubmission(classified.survivors);
      if (gate.kind !== 'ok') {
        // Preflight failures create no UUID, outbox hint, or request.
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

      // Revoke the previous submit, poll, and mount lookup before claiming a new epoch.
      abortRef.current?.abort();
      stopPoll();
      mountAbortRef.current?.abort();
      const epoch = ++runEpochRef.current;
      // Create before digest so unmount can cancel its continuation.
      const abort = new AbortController();
      abortRef.current = abort;

      setIsPending(true);
      setChunkProgress(null);
      chunkCountRef.current = 1;
      const items$ = classified.survivors;
      submittedPathsRef.current = new Set(items$.map((i) => i.path));
      stayOnCleanRef.current = shouldStayOnClean ? shouldStayOnClean() : false;
      const digestInput = { source, ...(source === 'manual' && mode !== undefined ? { mode } : {}), items: [...items$] };
      let clientSubmissionId: string;
      try {
        clientSubmissionId = generateClientSubmissionId();
      } catch (error: unknown) {
        setIsPending(false);
        setBanner(error instanceof EntropyUnavailableError ? error.message : STAGED_COPY.createUnreachable);
        return;
      }
      void computeSubmissionDigest(digestInput).then((payloadDigest) => {
        if (abort.signal.aborted || epoch !== runEpochRef.current) return;
        return runPipeline(items$, clientSubmissionId, payloadDigest, mode, epoch, abort);
      });
    },
    [runPipeline, stopPoll, source, shouldStayOnClean],
  );

  const dismissBanner = useCallback(() => setBanner(null), []);

  // Recover a source-scoped outbox hint on mount.
  useEffect(() => {
    const record = readOutbox(source);
    if (!record) return;
    const recordClientId = record.clientSubmissionId;
    const epoch = ++runEpochRef.current;
    const abort = new AbortController();
    mountAbortRef.current = abort;
    void (async () => {
      const result = await reconcileByClient({ api, clientSubmissionId: recordClientId, signal: abort.signal });
      if (abort.signal.aborted || epoch !== runEpochRef.current) return;
      switch (result.action) {
        case 'rejoin':
          startPoll(result.submissionId, true, recordClientId, epoch);
          break;
        case 'evict':
          evictOutbox(source, recordClientId); // Only if the slot still holds this hint.
          break;
        case 'lookup-failed':
          setBanner(STAGED_COPY.createUnreachable); // Keep the recovery pointer.
          break;
        case 'aborted':
          break;
      }
    })();
    return () => abort.abort();
    // Mount once per source; startPoll identity must not restart recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      mountAbortRef.current?.abort();
      pollRef.current?.stop();
    };
  }, []);

  return { submit, isPending, chunkProgress, banner, dismissBanner };
}
