import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { api, type ImportMode, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { useMatchJob } from '@/hooks/useMatchJob';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import { isPathInsideLibrary } from '@/lib/pathUtils.js';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';
import { needsChapterCorroboration, stampRow, useRepickCorroboration } from '@/lib/repick-corroboration.js';
import { useStagedSubmission } from '@/lib/staged-import/useStagedSubmission.js';

export type Step = 'path' | 'review';

interface UseManualImportOptions {
  onScanSuccess?: (path: string) => void;
  libraryPath?: string;
}

// eslint-disable-next-line max-lines-per-function -- orchestrates 5 mutations, 3 effects, 8 callbacks for import flow
export function useManualImport({ onScanSuccess, libraryPath }: UseManualImportOptions = {}) {
  const navigate = useNavigate();
  const {
    results: matchResults, progress, isMatching, recovering,
    paused, reason: pausedReason, remaining: matchRemaining, matchedCount: _matchedCount, total: matchTotal,
    startMatching, restart, resume, cancel: cancelMatching,
  } = useMatchJob();

  const [step, setStep] = useState<Step>('path');
  const [scanPath, setScanPath] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mode, setMode] = useState<ImportMode>('copy');
  const [editIndex, setEditIndex] = useState<number | null>(null);
  // Monotonic match generations reject stale chapter-runtime re-pick results.
  const { nextGeneration, dispatchCorroboration } = useRepickCorroboration(setRows);

  // Reconfirmation uses the original mode; this ref breaks the held-review/staged-submit cycle.
  const submitRef = useRef<(items: ImportConfirmItem[], mode: ImportMode | undefined) => void>(() => {});
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items, confirmMode) => submitRef.current(items, confirmMode),
  });

  const staged = useStagedSubmission({
    source: 'manual',
    acceptedVerb: 'queued for import',
    onCleanNavigate: () => navigate('/library'),
    onDeselectAccepted: (paths) => setRows((prev) => prev.map((r) => (paths.has(r.book.path) ? { ...r, selected: false } : r))),
    captureHeld,
    clearHeld,
  });
  const stagedSubmit = staged.submit;
  useEffect(() => {
    submitRef.current = (items, confirmMode) => stagedSubmit(items, confirmMode);
  }, [stagedSubmit]);
  const chunkProgress = staged.chunkProgress;
  const importMutation = { isPending: staged.isPending };

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

      // Duplicate rows are outside the match job; never auto-select a result that somehow arrives.
      if (row.book.isDuplicate) return row;

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
    onSuccess: (result, path) => {
      if (result.discoveries.length === 0) {
        setScanError('No audiobook folders found in this directory.');
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
      // Held paths belong to the previous scan.
      clearHeld();

      const candidates = result.discoveries
        .filter(d => !d.isDuplicate)
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
      onScanSuccess?.(path);
    },
    onError: (error: Error) => {
      setScanError(getErrorMessage(error));
    },
  });

  const handleScan = useCallback(() => {
    if (!scanPath.trim()) return;
    if (libraryPath && isPathInsideLibrary(scanPath, libraryPath)) return;
    setScanError(null);
    scanMutation.mutate(scanPath.trim());
  }, [scanPath, libraryPath, scanMutation]);

  const handleToggle = useCallback((index: number) => {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, selected: !r.selected } : r));
  }, []);

  const handleToggleAll = useCallback(() => {
    setRows(prev => {
      const allSelected = prev.every(r => r.selected);
      return prev.map(r => ({ ...r, selected: !allSelected }));
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
      return stampRow({ ...r, edited: state, selected: autoCheck, userEdited: true, matchResult }, generation);
    }));

    // Corroboration may only promote the optimistic verdict.
    if (previous && request) dispatchCorroboration({ path: previous.book.path, generation, request });
  }, [rows, nextGeneration, dispatchCorroboration]);

  const handleImport = useCallback(() => {
    // toConfirmItem still forces user-selected duplicates when the explicit force flag is false.
    const items = rows.filter(r => r.selected).map(r => toConfirmItem(r, false));
    staged.submit(items, mode);
  }, [rows, staged, mode]);

  // Restart from current edits; clear prior matches and reset the append offset.
  const handleRestartMatch = useCallback(() => {
    const candidates = rows
      .filter(r => !r.book.isDuplicate)
      .map(r => ({
        path: r.book.path,
        title: r.edited.title,
        ...(r.edited.author && { author: r.edited.author }),
        ...(r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
      }));
    if (candidates.length === 0) return;
    prevMatchCountRef.current = 0;
    const generation = nextGeneration();
    setRows(prev => prev.map(r => r.book.isDuplicate ? r : stampRow({ ...r, matchResult: undefined }, generation)));
    restart(candidates);
  }, [rows, restart, nextGeneration]);

  // useMatchJob preserves matched rows and resumes only the remainder.
  const handleResumeMatch = useCallback(() => resume(), [resume]);

  // The attention-banner reset must stay here; handleBack navigates from the path step.
  const resetToPath = useCallback(() => {
    cancelMatching();
    prevMatchCountRef.current = 0;
    setStep('path');
    setRows([]);
    clearHeld();
  }, [cancelMatching, clearHeld]);

  const handleBack = useCallback(() => {
    if (step === 'review') {
      resetToPath();
    } else {
      navigate('/library');
    }
  }, [step, resetToPath, navigate]);

  const selectedCount = rows.filter(r => r.selected).length;
  const selectedUnmatchedCount = rows.filter(r => r.selected && r.matchResult?.confidence === 'none').length;
  const readyCount = rows.filter(r => r.selected && !r.book.isDuplicate && r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult && !r.book.isDuplicate).length;
  const selectedPendingCount = rows.filter(r => r.selected && !r.matchResult && !r.book.isDuplicate).length;
  const duplicateCount = rows.filter(r => r.book.isDuplicate).length;
  const allSelected = rows.length > 0 && rows.every(r => r.selected);

  return {
    state: {
      step,
      scanPath,
      setScanPath,
      scanError,
      setScanError,
      rows,
      mode,
      setMode,
      editIndex,
      setEditIndex,
      isMatching,
      progress,
      chunkProgress,
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
      handleScan,
      handleToggle,
      handleToggleAll,
      handleEdit,
      handleImport,
      handleBack,
      resetToPath,
      handleReconfirmHeld,
      handleRestartMatch,
      handleResumeMatch,
    },
    mutations: {
      scanMutation,
      importMutation,
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
