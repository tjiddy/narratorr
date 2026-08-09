import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { matchesLibraryIdentity } from '@shared/dedup.js';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import type { DiscoveredBook } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';
import { needsChapterCorroboration, stampRow, useRepickCorroboration } from '@/lib/repick-corroboration.js';
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
  // Monotonic match generations reject stale chapter-runtime re-pick results.
  const { nextGeneration, dispatchCorroboration } = useRepickCorroboration(setRows);
  // The ref breaks the held-review/staged-submit cycle; Library mode is always undefined.
  const submitRef = useRef<(items: ImportConfirmItem[], mode: undefined) => void>(() => {});
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items) => submitRef.current(items, undefined),
  });

  const staged = useStagedSubmission({
    source: 'library',
    acceptedVerb: 'registered',
    onCleanNavigate: () => navigate('/library'),
    onDeselectAccepted: (paths) => setRows((prev) => prev.map((r) => (paths.has(r.book.path) ? { ...r, selected: false } : r))),
    captureHeld,
    clearHeld,
    // Stay mounted while paused or the resumable match remainder is lost.
    shouldStayOnClean: () => paused,
  });
  const stagedSubmit = staged.submit;
  useEffect(() => {
    submitRef.current = (items) => stagedSubmit(items, undefined);
  }, [stagedSubmit]);
  const chunkProgress = staged.chunkProgress;
  const registerMutation = { isPending: staged.isPending };

  const { data: settings, isError: settingsError } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  // Treat unresolved settings as configured to avoid flashing the empty-path state.
  const hasLibraryPath = settings === undefined && !settingsError
    ? true
    : !!settings?.library.path;

  const { data: bookIdentifiers } = useQuery({
    queryKey: queryKeys.bookIdentifiers(),
    queryFn: api.getBookIdentifiers,
  });

  const prevMatchCountRef = useRef(0);
  const mergeMatchResults = useCallback((results: MatchResult[]) => {
    const resultMap = new Map<string, MatchResult>();
    for (const r of results) {
      resultMap.set(r.path, r);
    }

    // Compute once outside the updater: StrictMode may invoke updater functions twice.
    const generation = nextGeneration();
    setRows(prev => prev.map(row => {
      const match = resultMap.get(row.book.path);
      if (!match) return row;
      if (isLibraryDbDuplicate(row.book)) return row;
      return stampRow(mergeMatchIntoRow(row, match), generation);
    }));
  }, [nextGeneration]);

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

      const scanGeneration = nextGeneration();
      const newRows: ImportRow[] = result.discoveries.map((book) => stampRow({
        book,
        selected: !book.isDuplicate,
        userEdited: false,
        edited: {
          title: book.parsedTitle,
          author: book.parsedAuthor || '',
          series: book.parsedSeries || '',
          ...(book.parsedSeriesPosition !== undefined && { seriesPosition: book.parsedSeriesPosition }),
        },
      }, scanGeneration));

      setRows(newRows);
      setScanError(null);
      setStep('review');

      const candidates = result.discoveries
        .filter(d => !isLibraryDbDuplicate(d))
        .map(d => ({
          path: d.path,
          title: d.parsedTitle,
          ...(d.parsedAuthor && { author: d.parsedAuthor }),
          // Preserve position 0; the ranker uses series position to break same-title ties.
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

  const didScanRef = useRef(false);
  useEffect(() => {
    if (didScanRef.current) return;

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
    // Read and stamp outside the updater; StrictMode may invoke updater functions twice.
    const previous = rows[index];
    const generation = nextGeneration();
    const request = previous && needsChapterCorroboration(previous.matchResult, state.metadata, previous.edited.metadata);

    setRows(prev => prev.map((r, i) => {
      if (i !== index) return r;

      const autoCheck = !r.selected && state.metadata ? true : r.selected;
      const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);

      let updatedBook: DiscoveredBook = r.book;

      // Recheck edited slug duplicates ASIN-first; title edits cannot clear an ASIN collision.
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

      return stampRow({ ...r, book: updatedBook, edited: state, selected: autoCheck, userEdited: true, ...(matchResult !== undefined && { matchResult }) }, generation);
    }));

    // Corroboration may only promote the optimistic verdict.
    if (previous && request) dispatchCorroboration({ path: previous.book.path, generation, request });
  }, [bookIdentifiers, rows, nextGeneration, dispatchCorroboration]);

  const handleRegister = useCallback(() => {
    const items = rows.filter(r => r.selected).map(r => toConfirmItem(r, false));
    staged.submit(items, undefined);
  }, [rows, staged]);

  // Mirror selectedPendingCount so matched selections and DB duplicates remain untouched.
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

  // Restart from current edits; clear prior matches and reset the append offset.
  const handleRestartMatch = useCallback(() => {
    const candidates = rows
      .filter(r => !isLibraryDbDuplicate(r.book))
      .map(r => ({
        path: r.book.path,
        title: r.edited.title,
        ...(r.edited.author && { author: r.edited.author }),
        ...(r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
      }));
    if (candidates.length === 0) return;
    prevMatchCountRef.current = 0;
    const generation = nextGeneration();
    setRows(prev => prev.map(r => isLibraryDbDuplicate(r.book) ? r : stampRow({ ...r, matchResult: undefined }, generation)));
    restart(candidates);
  }, [rows, restart, nextGeneration]);

  // useMatchJob preserves matched rows and resumes only the remainder.
  const handleResumeMatch = useCallback(() => resume(), [resume]);

  const selectedCount = rows.filter(r => r.selected).length;
  const selectedUnmatchedCount = rows.filter(r => r.selected && r.matchResult?.confidence === 'none').length;
  const readyCount = rows.filter(r => r.selected && !isLibraryDbDuplicate(r.book) && r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult && !isLibraryDbDuplicate(r.book)).length;
  const selectedPendingCount = rows.filter(r => r.selected && !r.matchResult && !isLibraryDbDuplicate(r.book)).length;
  const duplicateCount = rows.filter(r => isLibraryDbDuplicate(r.book)).length;
  const allSelected = rows.length > 0 && rows.filter(r => !isLibraryDbDuplicate(r.book)).every(r => r.selected);

  const libraryRoot = settings?.library.path ?? '';

  return {
    state: {
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
      recovering,
      paused,
      pausedReason,
      matchRemaining,
      matchTotal,
    },
    actions: {
      handleToggle,
      handleSelectAll,
      handleEdit,
      handleRegister,
      handleReconfirmHeld,
      handleRetry,
      handleRestartMatch,
      handleResumeMatch,
      handleDeselectPending,
    },
    mutations: {
      scanMutation,
      registerMutation,
    },
    counts: {
      selectedCount,
      selectedUnmatchedCount,
      readyCount,
      reviewCount,
      noMatchCount,
      pendingCount,
      selectedPendingCount,
      duplicateCount,
      allSelected,
    },
  };
}
