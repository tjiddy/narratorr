import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { matchesLibraryIdentity } from '../../../shared/dedup.js';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import type { DiscoveredBook } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';
import { useStagedSubmission } from '@/lib/staged-import/useStagedSubmission.js';
import { isLibraryDbDuplicate } from './isLibraryDbDuplicate.js';

export type Step = 'scanning' | 'review' | 'error';

// eslint-disable-next-line max-lines-per-function -- orchestrates scan, match job, and slug-duplicate recheck
export function useLibraryImport() {
  const navigate = useNavigate();
  const {
    results: matchResults, progress, isMatching, recovering,
    paused, reason: pausedReason, remaining: matchRemaining, matchedCount: _matchedCount, total: matchTotal,
    startMatching, restart, resume, cancel: _cancelMatching,
  } = useMatchJob();

  const [step, setStep] = useState<Step>('scanning');
  const [scanError, setScanError] = useState<string | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  // Held re-confirm (#1711) resubmits through the same staged pipeline. Library always
  // registers with mode `undefined`, so the snapshot is unused here. `submitRef` breaks
  // the cycle: held-review's `confirm` needs `staged.submit`, which needs `captureHeld`.
  const submitRef = useRef<(items: ImportConfirmItem[], mode: undefined) => void>(() => {});
  // Items the server held for recording review (#1711) — surfaced for re-confirm.
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items) => submitRef.current(items, undefined),
  });

  // Staged submit + poll pipeline (#1902) — replaces the direct chunked confirm.
  const staged = useStagedSubmission({
    source: 'library',
    acceptedVerb: 'registered',
    onCleanNavigate: () => navigate('/library'),
    onDeselectAccepted: (paths) => setRows((prev) => prev.map((r) => (paths.has(r.book.path) ? { ...r, selected: false } : r))),
    captureHeld,
    clearHeld,
    // Paused-subset import (#1895): a clean completion while the match run is paused must
    // stay on the page and deselect the accepted rows in place — navigating to /library would
    // unmount `useMatchJob` and dispose the paused engine, losing the resumable remainder.
    shouldStayOnClean: () => paused,
  });
  const stagedSubmit = staged.submit;
  useEffect(() => {
    submitRef.current = (items) => stagedSubmit(items, undefined);
  }, [stagedSubmit]);
  const chunkProgress = staged.chunkProgress;
  const registerMutation = { isPending: staged.isPending };

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
          // Thread the parsed series position (#1849) so the ranker can break
          // same-title series ties. `!== undefined` (never `||`) so position 0 survives.
          ...(d.parsedSeriesPosition !== undefined && { seriesPosition: d.parsedSeriesPosition }),
        }));
      if (candidates.length > 0) {
        startMatching(candidates);
      }
    },
    onError: (error: Error) => {
      setScanError(getErrorMessage(error));
    },
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
    staged.submit(items, undefined);
  }, [rows, staged]);

  // Deselect-pending affordance (#1895): while paused, clear `selected` on every pending row
  // — result-less and NOT a DB duplicate — so the remaining matched selection can import. The
  // predicate mirrors `selectedPendingCount` exactly (the canonical `isLibraryDbDuplicate`
  // helper, not a bare `!isDuplicate`): a within-scan duplicate is actionable and gets cleared,
  // a path/slug DB duplicate isn't selectable to begin with. Matched selections stay intact.
  const handleDeselectPending = useCallback(() => {
    setRows(prev => prev.map(r => (!r.matchResult && !isLibraryDbDuplicate(r.book)) ? { ...r, selected: false } : r));
  }, []);

  const handleRetry = useCallback(() => {
    const libraryPath = settings?.library.path ?? '';
    if (!libraryPath) return;
    setScanError(null);
    setEmptyResult(false);
    clearHeld();
    prevMatchCountRef.current = 0;
    scanMutation.mutate(libraryPath);
  }, [settings, scanMutation, clearHeld]);

  // Restart all (#1864 §5b) — rebuild candidates from CURRENT edited row values
  // (incl. edited seriesPosition, #1849), CLEAR every non-duplicate row's match to
  // pending (stale by construction), and reset the result-offset before the new run.
  const handleRestartMatch = useCallback(() => {
    const candidates = rows
      .filter(r => !isLibraryDbDuplicate(r.book))
      .map(r => ({
        path: r.book.path,
        title: r.edited.title,
        ...(r.edited.author && { author: r.edited.author }),
        // Guard preserves position 0 (#1028/#1849).
        ...(r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
      }));
    if (candidates.length === 0) return;
    prevMatchCountRef.current = 0;
    setRows(prev => prev.map(r => isLibraryDbDuplicate(r.book) ? r : { ...r, matchResult: undefined }));
    restart(candidates);
  }, [rows, restart]);

  // Resume remaining (#1864 §5) — re-match only the result-less remainder; rows that
  // already matched keep their result (the engine's observed map is preserved).
  const handleResumeMatch = useCallback(() => resume(), [resume]);

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
    rows,
    editIndex,
    setEditIndex,
    isMatching,
    progress,
    chunkProgress,
    libraryRoot,
    heldReview,
    banner: staged.banner,
    dismissBanner: staged.dismissBanner,

    // Match-phase recovery (#1864)
    recovering,
    paused,
    pausedReason,
    matchRemaining,
    matchTotal,

    handleToggle,
    handleSelectAll,
    handleEdit,
    handleRegister,
    handleReconfirmHeld,
    handleRetry,
    handleRestartMatch,
    handleResumeMatch,
    handleDeselectPending,

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
