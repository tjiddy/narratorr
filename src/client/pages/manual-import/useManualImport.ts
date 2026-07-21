import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, type ImportMode, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { useMatchJob } from '@/hooks/useMatchJob';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import { isPathInsideLibrary } from '@/lib/pathUtils.js';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';
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

  // Held-review recovery (#1732). Re-confirm uses the mode snapshotted at the original
  // confirm attempt, not the still-editable `mode` selector. `submitRef` breaks the cycle:
  // held-review's `confirm` needs `staged.submit`, which needs `captureHeld`.
  const submitRef = useRef<(items: ImportConfirmItem[], mode: ImportMode | undefined) => void>(() => {});
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items, confirmMode) => submitRef.current(items, confirmMode),
  });

  // Staged submit + poll pipeline (#1902) — replaces the direct chunked confirm.
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

  // Merge match results into rows state (single source of truth)
  const prevMatchCountRef = useRef(0);
  const mergeMatchResults = useCallback((results: MatchResult[]) => {
    const resultMap = new Map<string, MatchResult>();
    for (const r of results) {
      resultMap.set(r.path, r);
    }

    setRows(prev => prev.map(row => {
      const match = resultMap.get(row.book.path);
      if (!match) return row;

      // Duplicate rows are not in the match job — if a result somehow arrives, don't auto-select
      if (row.book.isDuplicate) return row;

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
    onSuccess: (result, path) => {
      if (result.discoveries.length === 0) {
        setScanError('No audiobook folders found in this directory.');
        return;
      }

      const newRows: ImportRow[] = result.discoveries.map((book) => ({
        book,
        // Duplicate rows start unchecked; new books start checked
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
      // A new scan supersedes any held rows from a prior directory (#1732) — clear
      // them so the panel never renders stale titles whose paths are gone.
      clearHeld();

      // Start matching only for non-duplicate books
      const candidates = result.discoveries
        .filter(d => !d.isDuplicate)
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
    setRows(prev => prev.map((r, i) => {
      if (i !== index) return r;
      const autoCheck = !r.selected && state.metadata ? true : r.selected;
      const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);
      return { ...r, edited: state, selected: autoCheck, userEdited: true, matchResult };
    }));
  }, []);

  const handleImport = useCallback(() => {
    // Shared canonical builder (#1732/#1765) — `forceImport` still derives from
    // `r.book.isDuplicate` for user-selected duplicates (force=false here).
    const items = rows.filter(r => r.selected).map(r => toConfirmItem(r, false));
    staged.submit(items, mode);
  }, [rows, staged, mode]);

  // Restart all (#1864 §5b) — rebuild candidates from CURRENT edited row values,
  // CLEAR every non-duplicate row's match to pending, and reset the result-offset.
  // Manual import had no prior re-match affordance; this wiring is new.
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
    setRows(prev => prev.map(r => r.book.isDuplicate ? r : { ...r, matchResult: undefined }));
    restart(candidates);
  }, [rows, restart]);

  // Resume remaining (#1864 §5) — re-match only the result-less remainder; already
  // matched rows keep their result (the engine's observed map is preserved).
  const handleResumeMatch = useCallback(() => resume(), [resume]);

  // Reset the page to the path step WITHOUT navigating away (#1894). This backs the
  // attention banner's "Import again" on Manual Import: the abandoned banner shows
  // from the normal `path` state, so calling `handleBack` there would navigate to
  // /library. `resetToPath` always lands on `path` and never leaves the page.
  const resetToPath = useCallback(() => {
    cancelMatching();
    prevMatchCountRef.current = 0;
    setStep('path');
    setRows([]);
    // Drop held rows so a reset can't leave a stale panel (#1732).
    clearHeld();
  }, [cancelMatching, clearHeld]);

  const handleBack = useCallback(() => {
    if (step === 'review') {
      resetToPath();
    } else {
      navigate('/library');
    }
  }, [step, resetToPath, navigate]);

  // Computed counts
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
      // Match-phase recovery (#1864)
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
