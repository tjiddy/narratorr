import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { matchesLibraryIdentity } from '../../../shared/dedup.js';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import type { DiscoveredBook } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';
import { acceptedItemPaths, buildChunkedOutcomeToast, isChunkedCleanImport, confirmErrorMessage } from '@/lib/import-outcome.js';
import { runChunkedConfirm } from '@/lib/confirm-chunk-runner.js';
import { isLibraryDbDuplicate } from './isLibraryDbDuplicate.js';

export type Step = 'scanning' | 'review' | 'error';

// eslint-disable-next-line max-lines-per-function -- orchestrates scan, match job, and slug-duplicate recheck
export function useLibraryImport() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { results: matchResults, progress, isMatching, error: matchJobError, startMatching, cancel: _cancelMatching } = useMatchJob();

  const [step, setStep] = useState<Step>('scanning');
  const [scanError, setScanError] = useState<string | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  // Progress across the sequential chunked confirm run (#1831) — drives "Registering X of Y…".
  const [chunkProgress, setChunkProgress] = useState<{ current: number; total: number; chunks: number } | null>(null);
  // Items the server held for recording review (#1711) — surfaced for re-confirm.
  // Library always registers with mode `undefined`, so the snapshot is unused here.
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items) => registerMutation.mutate(items),
  });

  // Settings query to get library path
  const { data: settings, isError: settingsError } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  // Derived from settings — no need for separate state. While loading we
  // assume a path exists so the UI doesn't flicker the "no library path"
  // message before the query resolves.
  const hasLibraryPath = settings === undefined && !settingsError
    ? true
    : !!settings?.library.path;

  // Book identifiers for slug-duplicate recheck
  const { data: bookIdentifiers } = useQuery({
    queryKey: queryKeys.bookIdentifiers(),
    queryFn: api.getBookIdentifiers,
  });

  // Merge match results into rows (same logic as useManualImport)
  const prevMatchCountRef = useRef(0);
  const mergeMatchResults = useCallback((results: MatchResult[]) => {
    const resultMap = new Map<string, MatchResult>();
    for (const r of results) {
      resultMap.set(r.path, r);
    }

    setRows(prev => prev.map(row => {
      const match = resultMap.get(row.book.path);
      if (!match) return row;
      if (isLibraryDbDuplicate(row.book)) return row;
      return mergeMatchIntoRow(row, match);
    }));
  }, []);

  useEffect(() => {
    if (matchResults.length === prevMatchCountRef.current) return;
    const newResults = matchResults.slice(prevMatchCountRef.current);
    prevMatchCountRef.current = matchResults.length;
    mergeMatchResults(newResults);
  }, [matchResults, mergeMatchResults]);

  const scanMutation = useMutation({
    mutationFn: (path: string) => api.scanDirectory(path),
    onSuccess: (result) => {
      if (result.discoveries.length === 0 || result.discoveries.every(d => isLibraryDbDuplicate(d))) {
        setEmptyResult(true);
        setStep('review');
        return;
      }

      const newRows: ImportRow[] = result.discoveries.map((book) => ({
        book,
        selected: !book.isDuplicate,
        userEdited: false,
        edited: {
          title: book.parsedTitle,
          author: book.parsedAuthor || '',
          series: book.parsedSeries || '',
          ...(book.parsedSeriesPosition !== undefined && { seriesPosition: book.parsedSeriesPosition }),
        },
      }));

      setRows(newRows);
      setScanError(null);
      setStep('review');

      const candidates = result.discoveries
        .filter(d => !isLibraryDbDuplicate(d))
        .map(d => ({
          path: d.path,
          title: d.parsedTitle,
          ...(d.parsedAuthor && { author: d.parsedAuthor }),
        }));
      if (candidates.length > 0) {
        startMatching(candidates);
      }
    },
    onError: (error: Error) => {
      setScanError(getErrorMessage(error));
    },
  });

  const registerMutation = useMutation({
    // Byte-budgeted chunked confirm (#1831). A large library exceeds the 1 MiB body
    // limit in one request, so the runner packs the selection into sub-1-MiB chunks and
    // POSTs them sequentially, resolving with the aggregate + the actually-submitted items.
    mutationFn: (items: ImportConfirmItem[]) =>
      runChunkedConfirm({ items, mode: undefined, confirm: api.confirmImport, onProgress: setChunkProgress }),
    onSuccess: (res) => {
      const { aggregateResult, submittedItems } = res;
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });

      // Held items (#1711): keep the user on the page so they can re-confirm them, instead
      // of navigating. Captured ONCE over the aggregate (#1831) — a per-chunk call would
      // clobber earlier chunks' held items. Surfaced separately from the outcome toast so a
      // held + skipped/failed batch is never swallowed by an early return (#1822).
      if (aggregateResult.heldReview.length > 0) {
        captureHeld(aggregateResult.heldReview, undefined);
        toast.warning(`${aggregateResult.heldReview.length} held for recording review`);
      } else {
        clearHeld();
      }

      // Report accepted/skipped/failed + the chunked transport splits (unsubmitted / too
      // large). Green fires ONLY on a fully-clean, fully-submitted outcome (#1822/#1831).
      const outcome = buildChunkedOutcomeToast(res, 'registered');
      if (outcome) toast[outcome.severity](outcome.message);

      // Navigate only when the ENTIRE selection landed accepted (nothing held/skipped/
      // failed/unsubmitted/too-large); otherwise stay and deselect the accepted rows over
      // submittedItems — NOT the full selection — so the never-sent remainder stays selected.
      if (isChunkedCleanImport(res)) {
        navigate('/library');
        return;
      }
      const acceptedPaths = acceptedItemPaths(submittedItems, aggregateResult);
      if (acceptedPaths.size > 0) {
        setRows(prev => prev.map(r => acceptedPaths.has(r.book.path) ? { ...r, selected: false } : r));
      }
    },
    onError: (error: Error) => {
      // First-chunk failure (nothing submitted) rejects here, exactly as a single-request
      // failure did. 413 (Fastify or the proxy hop) maps to import-domain wording (#1831).
      toast.error(`Import failed: ${confirmErrorMessage(error)}`);
    },
    onSettled: () => setChunkProgress(null),
  });

  // Auto-scan on mount once settings are loaded and we have a library path.
  const didScanRef = useRef(false);
  useEffect(() => {
    if (didScanRef.current) return;

    // Wait for settings to resolve (either success or error)
    if (settings === undefined && !settingsError) return;

    const libraryPath = settings?.library.path ?? '';
    if (!libraryPath) return;

    didScanRef.current = true;
    scanMutation.mutate(libraryPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, settingsError]);

  const handleToggle = useCallback((index: number) => {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, selected: !r.selected } : r));
  }, []);

  const handleSelectAll = useCallback(() => {
    setRows(prev => {
      const selectableRows = prev.filter(r => !isLibraryDbDuplicate(r.book));
      const allSelected = selectableRows.length > 0 && selectableRows.every(r => r.selected);
      return prev.map(r => isLibraryDbDuplicate(r.book) ? r : { ...r, selected: !allSelected });
    });
  }, []);

  const handleEdit = useCallback((index: number, state: BookEditState) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== index) return r;

      const autoCheck = !r.selected && state.metadata ? true : r.selected;
      const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);

      let updatedBook: DiscoveredBook = r.book;

      // Slug-duplicate recheck: if this was flagged a DB duplicate, see if the
      // edited identity still collides. Runs the FULL shared predicate (#1662 F5)
      // — ASIN-first, then normalized title+author — over each library identifier
      // (which carries asin/title/authorSlug). Because every library-identity hit
      // now reports `duplicateReason: 'slug'` (including ASIN hits), an ASIN-flagged
      // row stays flagged after title/author edits that no longer textually collide
      // but whose ASIN still matches.
      if (r.book.isDuplicate && r.book.duplicateReason === 'slug' && bookIdentifiers) {
        const candidate = {
          title: state.title,
          ...(state.author !== undefined && { authorName: state.author }),
          ...(state.asin !== undefined && { asin: state.asin }),
        };
        const stillCollides = bookIdentifiers.some(lb => matchesLibraryIdentity(candidate, lb));
        if (!stillCollides) {
          updatedBook = { ...r.book, isDuplicate: false };
        }
      }

      const updated: ImportRow = { ...r, book: updatedBook, edited: state, selected: autoCheck, userEdited: true, ...(matchResult !== undefined && { matchResult }) };
      return updated;
    }));
  }, [bookIdentifiers]);

  const handleRegister = useCallback(() => {
    const items = rows.filter(r => r.selected).map(r => toConfirmItem(r, false));
    registerMutation.mutate(items);
  }, [rows, registerMutation]);

  const handleRetry = useCallback(() => {
    const libraryPath = settings?.library.path ?? '';
    if (!libraryPath) return;
    setScanError(null);
    setEmptyResult(false);
    clearHeld();
    prevMatchCountRef.current = 0;
    scanMutation.mutate(libraryPath);
  }, [settings, scanMutation, clearHeld]);

  const handleRetryMatch = useCallback(() => {
    const candidates = rows
      .filter(r => !isLibraryDbDuplicate(r.book))
      .map(r => ({
        path: r.book.path,
        title: r.edited.title,
        ...(r.edited.author && { author: r.edited.author }),
      }));
    if (candidates.length > 0) {
      prevMatchCountRef.current = 0;
      startMatching(candidates);
    }
  }, [rows, startMatching]);

  // Computed counts
  const selectedCount = rows.filter(r => r.selected).length;
  const selectedUnmatchedCount = rows.filter(r => r.selected && r.matchResult?.confidence === 'none').length;
  const readyCount = rows.filter(r => r.selected && !isLibraryDbDuplicate(r.book) && r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult && !isLibraryDbDuplicate(r.book)).length;
  const selectedPendingCount = rows.filter(r => r.selected && !r.matchResult && !isLibraryDbDuplicate(r.book)).length;
  const duplicateCount = rows.filter(r => isLibraryDbDuplicate(r.book)).length;
  const allSelected = rows.length > 0 && rows.filter(r => !isLibraryDbDuplicate(r.book)).every(r => r.selected);

  // Library root path for relative-path computation
  const libraryRoot = settings?.library.path ?? '';

  return {
    step,
    hasLibraryPath,
    scanError,
    emptyResult,
    matchJobError,
    rows,
    editIndex,
    setEditIndex,
    isMatching,
    progress,
    chunkProgress,
    libraryRoot,
    heldReview,

    handleToggle,
    handleSelectAll,
    handleEdit,
    handleRegister,
    handleReconfirmHeld,
    handleRetry,
    handleRetryMatch,

    scanMutation,
    registerMutation,

    selectedCount,
    selectedUnmatchedCount,
    readyCount,
    reviewCount,
    noMatchCount,
    pendingCount,
    selectedPendingCount,
    duplicateCount,
    allSelected,
  };
}
