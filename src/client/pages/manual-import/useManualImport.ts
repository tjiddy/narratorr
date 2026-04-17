import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportMode, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import type { ImportRow, BookEditState } from '@/components/manual-import';
import { isPathInsideLibrary } from '@/lib/pathUtils.js';
import { getErrorMessage } from '@/lib/error-message.js';

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

      // Auto-uncheck no-match rows (spec: 0 matches → Unchecked)
      const selected = match.confidence === 'none' ? false : row.selected;

      // Auto-populate edited fields from best match if not already manually edited
      const wasEdited = row.edited.metadata !== undefined;
      if (!wasEdited && match.bestMatch) {
        return {
          ...row,
          matchResult: match,
          selected,
          edited: {
            title: match.bestMatch.title,
            author: match.bestMatch.authors?.[0]?.name ?? row.edited.author,
            series: match.bestMatch.series?.[0]?.name ?? row.edited.series,
            coverUrl: match.bestMatch.coverUrl,
            asin: match.bestMatch.asin,
            metadata: match.bestMatch,
          },
        };
      }
      return { ...row, matchResult: match, selected };
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
        edited: {
          title: book.parsedTitle,
          author: book.parsedAuthor || '',
          series: book.parsedSeries || '',
        },
      }));

      setRows(newRows);
      setScanError(null);
      setStep('review');

      // Start matching only for non-duplicate books
      const candidates = result.discoveries
        .filter(d => !d.isDuplicate)
        .map(d => ({
          path: d.path,
          title: d.parsedTitle,
          author: d.parsedAuthor || undefined,
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
    mutationFn: (items: ImportConfirmItem[]) => api.confirmImport(items, mode),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      toast.success(`${result.accepted} book${result.accepted !== 1 ? 's' : ''} queued for import`);
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
      // Upgrade confidence when user explicitly selects provider metadata:
      // none → medium (user provided metadata on an unmatched row)
      // medium → high (user confirmed/re-selected on a review row)
      // The medium→high upgrade requires a NEW metadata selection (different reference),
      // not just the pre-populated bestMatch passed back unchanged on save.
      const metadataChanged = state.metadata && state.metadata !== r.edited.metadata;
      const matchResult = r.matchResult && state.metadata
        ? r.matchResult.confidence === 'none'
          ? { ...r.matchResult, confidence: 'medium' as const }
          : r.matchResult.confidence === 'medium' && metadataChanged
            ? { ...r.matchResult, confidence: 'high' as const, reason: undefined }
            : r.matchResult
        : r.matchResult;
      return { ...r, edited: state, selected: autoCheck, matchResult };
    }));
  }, []);

  const handleImport = useCallback(() => {
    const selected = rows.filter(r => r.selected);
    const items: ImportConfirmItem[] = selected.map(r => ({
      path: r.book.path,
      title: r.edited.title,
      authorName: r.edited.author || undefined,
      seriesName: r.edited.series || undefined,
      coverUrl: r.edited.coverUrl,
      asin: r.edited.asin,
      metadata: r.edited.metadata,
      // Duplicate rows that user explicitly selected require force-import to bypass safety net
      ...(r.book.isDuplicate ? { forceImport: true } : {}),
    }));
    importMutation.mutate(items);
  }, [rows, importMutation]);

  const handleBack = useCallback(() => {
    if (step === 'review') {
      cancelMatching();
      prevMatchCountRef.current = 0;
      setStep('path');
      setRows([]);
    } else {
      navigate('/library');
    }
  }, [step, cancelMatching, navigate]);

  // Computed counts
  const selectedCount = rows.filter(r => r.selected).length;
  const selectedUnmatchedCount = rows.filter(r => r.selected && r.matchResult?.confidence === 'none').length;
  const readyCount = rows.filter(r => r.selected && !r.book.isDuplicate && r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult && !r.book.isDuplicate).length;
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
    },
    actions: {
      handleScan,
      handleToggle,
      handleToggleAll,
      handleEdit,
      handleImport,
      handleBack,
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
      duplicateCount,
      allSelected,
    },
  };
}
