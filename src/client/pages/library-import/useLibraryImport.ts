import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { slugify } from '../../../shared/utils.js';
import { buildEditedFromBestMatch, type ImportRow, type BookEditState } from '@/components/manual-import';
import type { DiscoveredBook } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { upgradeMatchConfidence } from '@/lib/upgrade-match-confidence.js';

export type Step = 'scanning' | 'review' | 'error';

/** Returns true for DB-backed duplicates (path/slug), false for within-scan duplicates and non-duplicates. */
function isDbDuplicate(book: DiscoveredBook): boolean {
  return book.isDuplicate && book.duplicateReason !== 'within-scan';
}

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
      if (isDbDuplicate(row.book)) return row;

      const selected = match.confidence === 'none' ? false : row.selected;
      const wasEdited = row.edited.metadata !== undefined;
      if (!wasEdited && match.bestMatch) {
        return {
          ...row,
          matchResult: match,
          selected,
          edited: buildEditedFromBestMatch(match.bestMatch, row.edited),
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
    onSuccess: (result) => {
      if (result.discoveries.length === 0 || result.discoveries.every(d => isDbDuplicate(d))) {
        setEmptyResult(true);
        setStep('review');
        return;
      }

      const newRows: ImportRow[] = result.discoveries.map((book) => ({
        book,
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

      const candidates = result.discoveries
        .filter(d => !isDbDuplicate(d))
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
    mutationFn: (items: ImportConfirmItem[]) => api.confirmImport(items, undefined),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      toast.success(`${result.accepted} book${result.accepted !== 1 ? 's' : ''} registered`);
      navigate('/library');
    },
    onError: (error: Error) => {
      toast.error(`Registration failed: ${getErrorMessage(error)}`);
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
      const selectableRows = prev.filter(r => !isDbDuplicate(r.book));
      const allSelected = selectableRows.length > 0 && selectableRows.every(r => r.selected);
      return prev.map(r => isDbDuplicate(r.book) ? r : { ...r, selected: !allSelected });
    });
  }, []);

  const handleEdit = useCallback((index: number, state: BookEditState) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== index) return r;

      const autoCheck = !r.selected && state.metadata ? true : r.selected;
      const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);

      let updatedBook: DiscoveredBook = r.book;

      // Slug-duplicate recheck: if this was a slug-duplicate, see if edited title+author no longer collides.
      // Exact title equality matches the backend's findDuplicate() contract.
      if (r.book.isDuplicate && r.book.duplicateReason === 'slug' && bookIdentifiers) {
        const editedAuthorSlug = slugify(state.author ?? '');
        const stillCollides = bookIdentifiers.some(
          lb => lb.title === state.title && lb.authorSlug === editedAuthorSlug,
        );
        if (!stillCollides) {
          updatedBook = { ...r.book, isDuplicate: false };
        }
      }

      const updated: ImportRow = { ...r, book: updatedBook, edited: state, selected: autoCheck, ...(matchResult !== undefined && { matchResult }) };
      return updated;
    }));
  }, [bookIdentifiers]);

  const handleRegister = useCallback(() => {
    const selected = rows.filter(r => r.selected);
    const items: ImportConfirmItem[] = selected.map(r => ({
      path: r.book.path,
      title: r.edited.title,
      ...(r.edited.author && { authorName: r.edited.author }),
      ...(r.edited.series && { seriesName: r.edited.series }),
      ...(r.edited.narrators?.length && { narrators: r.edited.narrators }),
      ...(r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
      ...(r.edited.coverUrl !== undefined && { coverUrl: r.edited.coverUrl }),
      ...(r.edited.asin !== undefined && { asin: r.edited.asin }),
      ...(r.edited.metadata !== undefined && { metadata: r.edited.metadata }),
      ...(r.book.isDuplicate ? { forceImport: true } : {}),
    }));
    registerMutation.mutate(items);
  }, [rows, registerMutation]);

  const handleRetry = useCallback(() => {
    const libraryPath = settings?.library.path ?? '';
    if (!libraryPath) return;
    setScanError(null);
    setEmptyResult(false);
    prevMatchCountRef.current = 0;
    scanMutation.mutate(libraryPath);
  }, [settings, scanMutation]);

  const handleRetryMatch = useCallback(() => {
    const candidates = rows
      .filter(r => !isDbDuplicate(r.book))
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
  const readyCount = rows.filter(r => r.selected && !isDbDuplicate(r.book) && r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult && !isDbDuplicate(r.book)).length;
  const duplicateCount = rows.filter(r => isDbDuplicate(r.book)).length;
  const allSelected = rows.length > 0 && rows.filter(r => !isDbDuplicate(r.book)).every(r => r.selected);

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
    libraryRoot,

    handleToggle,
    handleSelectAll,
    handleEdit,
    handleRegister,
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
    duplicateCount,
    allSelected,
  };
}
