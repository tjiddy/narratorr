import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportMode, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { mergeMatchIntoRow, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useHeldReview, toConfirmItem } from '@/components/held-review';
import { isPathInsideLibrary } from '@/lib/pathUtils.js';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';

export type Step = 'path' | 'review';

interface UseManualImportOptions {
  onScanSuccess?: (path: string) => void;
  libraryPath?: string;
}

// eslint-disable-next-line max-lines-per-function -- orchestrates 5 mutations, 3 effects, 8 callbacks for import flow
export function useManualImport({ onScanSuccess, libraryPath }: UseManualImportOptions = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { results: matchResults, progress, isMatching, startMatching, cancel: cancelMatching } = useMatchJob();

  const [step, setStep] = useState<Step>('path');
  const [scanPath, setScanPath] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mode, setMode] = useState<ImportMode>('copy');
  const [editIndex, setEditIndex] = useState<number | null>(null);

  // Held-review recovery (#1732). Re-confirm uses the mode snapshotted at the
  // original confirm attempt, not the still-editable `mode` selector.
  const { heldReview, captureHeld, clearHeld, handleReconfirmHeld } = useHeldReview({
    rows,
    confirm: (items, confirmMode) => importMutation.mutate({ items, mode: confirmMode }),
  });

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

  const importMutation = useMutation({
    // The mode is carried in the mutation variables so the held-review snapshot
    // captures the value in effect at *this* confirm attempt (#1732), not a later
    // selector change.
    mutationFn: ({ items, mode: confirmMode }: { items: ImportConfirmItem[]; mode: ImportMode | undefined }) =>
      api.confirmImport(items, confirmMode),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      toast.success(`${result.accepted} book${result.accepted !== 1 ? 's' : ''} queued for import`);
      // Partial success (#1711/#1732): some items were held for recording review.
      // Keep the user on the page with a recovery panel instead of navigating away
      // (the old "re-confirm from Library Import" path was a dead end — manual
      // sources live outside the library root Library Import scans). Snapshot the
      // confirm-attempt mode so a held Move never silently re-confirms as Copy.
      if (result.heldReview.length > 0) {
        captureHeld(result.heldReview, variables.mode);
        toast.warning(`${result.heldReview.length} held for recording review`);
        return;
      }
      clearHeld();
      navigate('/library');
    },
    onError: (error: Error) => {
      toast.error(`Import failed: ${getErrorMessage(error)}`);
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
    importMutation.mutate({ items, mode });
  }, [rows, importMutation, mode]);

  const handleBack = useCallback(() => {
    if (step === 'review') {
      cancelMatching();
      prevMatchCountRef.current = 0;
      setStep('path');
      setRows([]);
      // Drop held rows so backing out of review can't leave a stale panel (#1732).
      clearHeld();
    } else {
      navigate('/library');
    }
  }, [step, cancelMatching, navigate, clearHeld]);

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
      heldReview,
    },
    actions: {
      handleScan,
      handleToggle,
      handleToggleAll,
      handleEdit,
      handleImport,
      handleBack,
      handleReconfirmHeld,
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
