import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportMode, type ImportConfirmItem, type MatchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ImportCard, ImportSummaryBar, BookEditModal, type ImportRow, type BookEditState } from '@/components/manual-import';
import { useMatchJob } from '@/hooks/useMatchJob';
import {
  FolderIcon,
  AlertCircleIcon,
  LoadingSpinner,
  ArrowLeftIcon,
  CheckIcon,
} from '@/components/icons';

type Step = 'path' | 'review';

export function ManualImportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { results: matchResults, progress, isMatching, startMatching, cancel: cancelMatching } = useMatchJob();

  const [step, setStep] = useState<Step>('path');
  const [scanPath, setScanPath] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mode, setMode] = useState<ImportMode>('copy');
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [skippedDuplicates, setSkippedDuplicates] = useState(0);

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
    onSuccess: (result) => {
      if (result.discoveries.length === 0) {
        setScanError(
          result.skippedDuplicates > 0
            ? `Found ${result.totalFolders} folder${result.totalFolders !== 1 ? 's' : ''}, but all ${result.skippedDuplicates} are already in your library.`
            : 'No audiobook folders found in this directory.',
        );
        return;
      }

      const newRows: ImportRow[] = result.discoveries.map((book) => ({
        book,
        selected: true,
        edited: {
          title: book.parsedTitle,
          author: book.parsedAuthor || '',
          series: book.parsedSeries || '',
        },
      }));

      setRows(newRows);
      setSkippedDuplicates(result.skippedDuplicates);
      setScanError(null);
      setStep('review');

      // Start matching immediately — server handles audio scanning for duration
      const candidates = result.discoveries.map(d => ({
        path: d.path,
        title: d.parsedTitle,
        author: d.parsedAuthor || undefined,
      }));
      startMatching(candidates);
    },
    onError: (error: Error) => {
      setScanError(error.message);
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
      toast.error(`Import failed: ${error.message}`);
    },
  });

  const handleScan = () => {
    if (!scanPath.trim()) return;
    setScanError(null);
    scanMutation.mutate(scanPath.trim());
  };

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
      // Auto-check if user picked a match on a previously unmatched row
      const autoCheck = !r.selected && state.metadata ? true : r.selected;
      // Promote confidence when user picks metadata on an unmatched row
      const matchResult = r.matchResult && r.matchResult.confidence === 'none' && state.metadata
        ? { ...r.matchResult, confidence: 'medium' as const }
        : r.matchResult;
      return { ...r, edited: state, selected: autoCheck, matchResult };
    }));
  }, []);

  const handleImport = () => {
    const selected = rows.filter(r => r.selected);
    const items: ImportConfirmItem[] = selected.map(r => ({
      path: r.book.path,
      title: r.edited.title,
      authorName: r.edited.author || undefined,
      seriesName: r.edited.series || undefined,
      coverUrl: r.edited.coverUrl,
      asin: r.edited.asin,
      metadata: r.edited.metadata,
    }));
    importMutation.mutate(items);
  };

  const handleBack = () => {
    if (step === 'review') {
      cancelMatching();
      prevMatchCountRef.current = 0;
      setStep('path');
      setRows([]);
      setSkippedDuplicates(0);
    } else {
      navigate('/library');
    }
  };

  // Counts for summary bar
  const selectedCount = rows.filter(r => r.selected).length;
  const selectedUnmatchedCount = rows.filter(r => r.selected && r.matchResult?.confidence === 'none').length;
  const readyCount = rows.filter(r => r.matchResult?.confidence === 'high').length;
  const reviewCount = rows.filter(r => r.matchResult?.confidence === 'medium').length;
  const noMatchCount = rows.filter(r => r.matchResult?.confidence === 'none').length;
  const pendingCount = rows.filter(r => !r.matchResult).length;
  const allSelected = rows.length > 0 && rows.every(r => r.selected);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in-up">
        <div className="flex items-center gap-3 mb-1">
          <button
            onClick={handleBack}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Back"
          >
            <ArrowLeftIcon className="w-4 h-4" />
          </button>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Manual Import</h1>
        </div>
        <p className="text-muted-foreground mt-1 ml-10">
          {step === 'path'
            ? 'Scan a directory to discover audiobooks'
            : isMatching
              ? `Matching ${progress.matched}/${progress.total}...`
              : `${rows.length} book${rows.length !== 1 ? 's' : ''} discovered`}
        </p>
      </div>

      {/* Step 1: Path Input */}
      {step === 'path' && (
        <div className="max-w-xl space-y-4 animate-fade-in-up stagger-1">
          <div className="relative">
            <FolderIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={scanPath}
              onChange={(e) => { setScanPath(e.target.value); setScanError(null); }}
              placeholder="/path/to/audiobooks"
              className="w-full pl-10 pr-4 py-3 glass-card rounded-xl text-sm focus-ring"
              onKeyDown={(e) => e.key === 'Enter' && handleScan()}
              autoFocus
            />
          </div>

          {scanError && (
            <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-500/5 border border-amber-500/20">
              <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <span className="text-sm text-amber-300/90">{scanError}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground/70">
              Point to a folder containing audiobook subfolders (Author/Title, etc.)
            </p>
            <button
              onClick={handleScan}
              disabled={!scanPath.trim() || scanMutation.isPending}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              {scanMutation.isPending && <LoadingSpinner className="w-3.5 h-3.5" />}
              {scanMutation.isPending ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Review Cards */}
      {step === 'review' && (
        <div className="animate-fade-in-up stagger-1">
          <div className="glass-card rounded-xl overflow-hidden">
            {/* Select all header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5">
              <button
                onClick={handleToggleAll}
                className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
                  allSelected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-border/60 hover:border-primary/50'
                }`}
                aria-label={allSelected ? 'Deselect all' : 'Select all'}
              >
                {allSelected && <CheckIcon className="w-3 h-3" />}
              </button>
              <span className="text-xs font-medium text-muted-foreground">
                {selectedCount} of {rows.length} selected
              </span>
            </div>

            {/* Card list */}
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-white/5">
              {rows.map((row, index) => (
                <ImportCard
                  key={row.book.path}
                  row={row}
                  onToggle={() => handleToggle(index)}
                  onEdit={() => setEditIndex(index)}
                />
              ))}
            </div>

            {/* Summary bar */}
            <ImportSummaryBar
              readyCount={readyCount}
              reviewCount={reviewCount}
              noMatchCount={noMatchCount}
              pendingCount={pendingCount}
              selectedCount={selectedCount}
              selectedUnmatchedCount={selectedUnmatchedCount}
              skippedDuplicates={skippedDuplicates}
              isMatching={isMatching}
              mode={mode}
              onModeChange={setMode}
              onImport={handleImport}
              importing={importMutation.isPending}
            />
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editIndex !== null && rows[editIndex] && (
        <BookEditModal
          book={rows[editIndex].book}
          initial={rows[editIndex].edited}
          confidence={rows[editIndex].matchResult?.confidence}
          alternatives={rows[editIndex].matchResult?.alternatives}
          onSave={(state) => {
            handleEdit(editIndex, state);
            setEditIndex(null);
          }}
          onClose={() => setEditIndex(null)}
        />
      )}
    </div>
  );
}
