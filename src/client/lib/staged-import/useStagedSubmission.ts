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
import { acceptedItemPaths } from '@/lib/import-outcome.js';

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

// eslint-disable-next-line max-lines-per-function -- one cohesive submit/poll/reconcile lifecycle; splitting it would scatter shared refs
export function useStagedSubmission(params: UseStagedSubmissionParams): UseStagedSubmission {
  const { source, acceptedVerb, onCleanNavigate, onDeselectAccepted, captureHeld, clearHeld } = params;
  const queryClient = useQueryClient();

  const [isPending, setIsPending] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<StagedProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Per-submission scratch that must survive re-renders without re-triggering effects.
  const abortRef = useRef<AbortController | null>(null);
  const mountAbortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<PollController | null>(null);
  const localExclusionsRef = useRef<LocalExclusions>({ invalid: 0, oversize: 0 });
  const modeRef = useRef<ImportMode | undefined>(undefined);
  const chunkCountRef = useRef(1);
  // The frozen in-session submitted paths (F4/F48): deselection is scoped to THIS session's
  // submitted rows, never a recovered receipt, and never applied to a remount projection.
  const submittedPathsRef = useRef<ReadonlySet<string>>(new Set());
  // Monotonic run epoch (F19). Every submit bumps it; the digest continuation, the transport
  // chain, and every poll/state callback are gated on "am I still the current epoch?" so a
  // superseded run (or one whose component unmounted mid-digest) can never publish state,
  // start a poll, or stop the newer run's poll.
  const runEpochRef = useRef(0);

  const invalidateReportReads = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.importSubmissions.root() });
  }, [queryClient]);

  const stopPoll = useCallback(() => {
    pollRef.current?.stop();
    pollRef.current = null;
  }, []);

  // ── Terminal detail projection → count-driven outcome / navigation / deselect ──
  const projectOutcome = useCallback(
    (detail: SubmissionResponse, recovered: boolean, clientSubmissionId: string) => {
      setIsPending(false);
      setChunkProgress(null);
      // A completion recovered on remount has no surviving in-session summary (F29).
      const local: LocalExclusions = recovered ? { invalid: 0, oversize: 0 } : localExclusionsRef.current;
      const agg = detail.aggregates;
      const items = !detail.detailsPruned && 'items' in detail && detail.items ? detail.items : undefined;

      // Held rows: capture into the LIVE re-confirm panel only in-session — a completion
      // recovered on remount keeps held detail read-only (F5/F66), because the captured mode
      // is gone and cross-reload re-confirm is unsupported. The warning toast still informs.
      if (items) {
        const held = items.filter((i): i is Extract<StagedItemResultDto, { disposition: 'held' }> => i.disposition === 'held');
        if (held.length > 0) {
          if (!recovered) captureHeld(held.map(toHeldReviewItem), modeRef.current);
          toast.warning(`${held.length} held for recording review`);
        } else if (!recovered) {
          clearHeld();
        }
      }

      // Skip clause names the reason/incumbent title while the detail survives (F9).
      const skippedRows = items
        ?.filter((i): i is Extract<StagedItemResultDto, { disposition: 'skipped' }> => i.disposition === 'skipped')
        .map((i) => ({ reason: i.reason, ...(i.existingTitle !== undefined ? { existingTitle: i.existingTitle } : {}) }));
      const outcome = buildStagedOutcomeToast(agg, local, acceptedVerb, skippedRows);
      if (outcome) toast[outcome.severity](outcome.message);

      // The accepted rows changed the library — refresh books + the #1894 report reads.
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      invalidateReportReads();

      // Guarded evict: a newer submit may already own the single slot (F1).
      evictOutbox(source, clientSubmissionId);

      // Clean AND in-session → navigate. A recovered projection NEVER navigates and NEVER
      // mutates the current selection (F4): the displayed rows may differ after a remount, so
      // deselection is scoped strictly to THIS session's frozen submitted paths.
      if (recovered) return;
      if (isCleanCompletion(agg, local)) {
        onCleanNavigate();
        return;
      }
      const acceptedDto = items ? acceptedItemPaths(items) : new Set<string>();
      const acceptedPaths = new Set([...acceptedDto].filter((p) => submittedPathsRef.current.has(p)));
      if (acceptedPaths.size > 0) onDeselectAccepted(acceptedPaths);
    },
    [acceptedVerb, captureHeld, clearHeld, invalidateReportReads, onCleanNavigate, onDeselectAccepted, queryClient, source],
  );

  const startPoll = useCallback(
    (submissionId: number, recovered: boolean, clientSubmissionId: string, epoch: number) => {
      // Ignore a start request from a superseded run — it must not stop the newer poll (F19).
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

  // ── In-session by-client recovery (F2) ────────────────────────────────────────
  // A finalize whose response is lost / exhausts retries may still have landed, so probe
  // by-client and rejoin the poll rather than waiting for a future remount.
  const recoverInSessionByClient = useCallback(
    async (clientSubmissionId: string, signal: AbortSignal, epoch: number) => {
      const result = await reconcileByClient({ api, clientSubmissionId, signal });
      // Discard the recovery of a superseded/aborted run (F19) — no poll rejoin, no state.
      if (signal.aborted || epoch !== runEpochRef.current) return;
      switch (result.action) {
        case 'rejoin':
          startPoll(result.submissionId, false, clientSubmissionId, epoch); // in-session: outcome/navigation still apply
          return;
        case 'evict': // receiving (finalize never landed) / never-landed → safe re-run
          setIsPending(false);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'lookup-failed':
          setIsPending(false);
          setBanner(STAGED_COPY.createUnreachable); // hint retained → later remount re-probes
          return;
        case 'aborted':
          return;
      }
    },
    [source, startPoll],
  );

  // ── SubmitError disposition → banner + outbox transition (F1 guarded, F7 distinct copy) ──
  const handleSubmitError = useCallback(
    (error: SubmitError, clientSubmissionId: string) => {
      setIsPending(false);
      setChunkProgress(null);
      switch (error.disposition) {
        case 'aborted':
          return; // unmount/navigation — surface nothing
        case 'create-unreachable':
          setBanner(STAGED_COPY.createUnreachable); // hint retained → next mount probes by-client
          return;
        case 'digest-conflict':
          setBanner(STAGED_COPY.digestConflict); // durable header left recoverable; fresh UUID on retry
          return;
        case 'put-failed':
          // Permanent PUT (400/409/413): NOT connectivity — the upload stopped, nothing imported.
          // Leave the `receiving` hint for the next mount's receiving/404 reconcile arm.
          setBanner(STAGED_COPY.putFailed);
          return;
        case 'create-invalid':
          setBanner(STAGED_COPY.createInvalid); // validation failure → evict, nothing landed
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-failed':
          setBanner(STAGED_COPY.finalizeFailed); // 409 gaps/digest-mismatch → cannot complete, evict
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-invariant':
          setBanner(STAGED_COPY.finalizeInvariant);
          evictOutbox(source, clientSubmissionId);
          return;
        case 'finalize-missing':
          evictOutbox(source, clientSubmissionId); // never landed — safe re-run, no error banner
          return;
        case 'finalize-unreachable':
          return; // handled by the in-session by-client recovery path (F2)
      }
    },
    [source],
  );

  const runPipeline = useCallback(
    async (survivorItems: Parameters<typeof runSubmit>[0]['items'], clientSubmissionId: string, payloadDigest: string, mode: ImportMode | undefined, epoch: number, abort: AbortController) => {
      // "Am I still the run the hook is committed to?" — false once a newer submit bumps the
      // epoch, or the component unmounts (which aborts this controller) (F19).
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
        if (!isCurrent()) return; // superseded/unmounted mid-flight → do not publish or start a poll
        markOutboxFinalized(source, submissionId, clientSubmissionId);
        startPoll(submissionId, false, clientSubmissionId, epoch);
      } catch (error: unknown) {
        // A superseded or aborted run surfaces nothing — the newer run (or unmount) owns state.
        if (!isCurrent()) return;
        if (error instanceof SubmitError) {
          // A finalize that exhausted retries / lost its response may already have landed —
          // probe by-client in-session and rejoin, rather than parking until a remount (F2).
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

      // Supersede any prior run BEFORE starting this one (F19): abort its in-flight
      // create/PUT/finalize (or pending digest), stop its poll, and abort a mount lookup, so
      // none of their late callbacks can publish state or take over poll ownership.
      abortRef.current?.abort();
      stopPoll();
      mountAbortRef.current?.abort();
      const epoch = ++runEpochRef.current;
      // Create the controller NOW, before the async digest — so an unmount during digest aborts
      // it and the continuation below bails out instead of starting the network chain (F19).
      const abort = new AbortController();
      abortRef.current = abort;

      setIsPending(true);
      setChunkProgress(null);
      chunkCountRef.current = 1;
      const items$ = classified.survivors;
      // Freeze the submitted paths NOW (F4): deselection later is scoped to this exact set.
      submittedPathsRef.current = new Set(items$.map((i) => i.path));
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
        // Superseded by a newer submit, or unmounted, while the digest was computing → bail (F19).
        if (abort.signal.aborted || epoch !== runEpochRef.current) return;
        return runPipeline(items$, clientSubmissionId, payloadDigest, mode, epoch, abort);
      });
    },
    [runPipeline, stopPoll, source],
  );

  const dismissBanner = useCallback(() => setBanner(null), []);

  // ── Mount reconciliation via the source-scoped outbox hint (by-client) ────────
  useEffect(() => {
    const record = readOutbox(source);
    if (!record) return;
    const recordClientId = record.clientSubmissionId;
    // The mount recovery is itself an epoch'd run so a subsequent submit supersedes it (F19).
    const epoch = ++runEpochRef.current;
    const abort = new AbortController();
    mountAbortRef.current = abort;
    void (async () => {
      const result = await reconcileByClient({ api, clientSubmissionId: recordClientId, signal: abort.signal });
      // A submit that started mid-lookup aborts this controller (F1) and bumps the epoch (F19);
      // its late result must not rejoin the old poll or evict the newer hint.
      if (abort.signal.aborted || epoch !== runEpochRef.current) return;
      switch (result.action) {
        case 'rejoin':
          startPoll(result.submissionId, true, recordClientId, epoch);
          break;
        case 'evict':
          evictOutbox(source, recordClientId); // only if the slot still holds this hint
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

  // Abort any in-flight submit/lookup + stop polling on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      mountAbortRef.current?.abort();
      pollRef.current?.stop();
    };
  }, []);

  return { submit, isPending, chunkProgress, banner, dismissBanner };
}
