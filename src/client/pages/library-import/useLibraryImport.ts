import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMatchJob } from '@/hooks/useMatchJob';
import { slugify } from '../../../shared/utils.js';
import type { ImportRow, BookEditState } from '@/components/manual-import';
import type { DiscoveredBook } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';

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
  const [hasLibraryPath, setHasLibraryPath] = useState<boolean>(true);

  // Settings query to get library path
  const { data: settings, isError: settingsError } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

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
          author: d.parsedAuthor || undefined,
        }));
      if (candidates.length > 0) {
        startMatching(candidates);
      }
    },
    onError: (error: Error) => {
      setScanError(getErrorMessage(error, 'Scan failed'));
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

  // Auto-scan on mount once settings are loaded
  const didScanRef = useRef(false);
  useEffect(() => {
    if (didScanRef.current) return;

    // Wait for settings to resolve (either success or error)
    if (settings === undefined && !settingsError) return;

    const libraryPath = settings?.library.path ?? '';
    if (!libraryPath) {
      setHasLibraryPath(false);
      return;
    }

    didScanRef.current = true;
    setHasLibraryPath(true);
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

      let updatedBook = r.book;

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

      return { ...r, book: updatedBook, edited: state, selected: autoCheck, matchResult };
    }));
  }, [bookIdentifiers]);

  const handleRegister = useCallback(() => {
    const selected = rows.filter(r => r.selected);
    const items: ImportConfirmItem[] = selected.map(r => ({
      path: r.book.path,
      title: r.edited.title,
      authorName: r.edited.author || undefined,
      seriesName: r.edited.series || undefined,
      coverUrl: r.edited.coverUrl,
      asin: r.edited.asin,
      metadata: r.edited.metadata,
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
        author: r.edited.author || undefined,
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
