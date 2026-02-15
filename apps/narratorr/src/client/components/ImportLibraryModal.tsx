import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, formatBytes, type DiscoveredBook, type ImportConfirmItem } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FolderIcon, SearchIcon, LoadingSpinner } from '@/components/icons';

interface ImportLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultPath?: string;
}

type Step = 'input' | 'scanning' | 'review' | 'importing' | 'done';

export function ImportLibraryModal({ isOpen, onClose, defaultPath = '' }: ImportLibraryModalProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('input');
  const [scanPath, setScanPath] = useState(defaultPath);
  const [discoveries, setDiscoveries] = useState<DiscoveredBook[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scanStats, setScanStats] = useState({ totalFolders: 0, skippedDuplicates: 0 });
  const [importResult, setImportResult] = useState({ imported: 0, failed: 0 });

  const scanMutation = useMutation({
    mutationFn: (path: string) => api.scanDirectory(path),
    onSuccess: (result) => {
      setDiscoveries(result.discoveries);
      setScanStats({ totalFolders: result.totalFolders, skippedDuplicates: result.skippedDuplicates });
      setSelected(new Set(result.discoveries.map((_, i) => i)));
      setStep('review');
    },
    onError: (error: Error) => {
      toast.error(`Scan failed: ${error.message}`);
      setStep('input');
    },
  });

  const importMutation = useMutation({
    mutationFn: (items: ImportConfirmItem[]) => api.confirmImport(items),
    onSuccess: (result) => {
      setImportResult(result);
      setStep('done');
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} book${result.imported !== 1 ? 's' : ''}`);
      }
    },
    onError: (error: Error) => {
      toast.error(`Import failed: ${error.message}`);
      setStep('review');
    },
  });

  const handleScan = () => {
    if (!scanPath.trim()) return;
    setStep('scanning');
    scanMutation.mutate(scanPath.trim());
  };

  const handleConfirm = () => {
    const items: ImportConfirmItem[] = discoveries
      .filter((_, i) => selected.has(i))
      .map((d) => ({
        path: d.path,
        title: d.parsedTitle,
        authorName: d.parsedAuthor || undefined,
        seriesName: d.parsedSeries || undefined,
      }));

    if (items.length === 0) {
      toast.error('No books selected');
      return;
    }

    setStep('importing');
    importMutation.mutate(items);
  };

  const handleClose = () => {
    setStep('input');
    setDiscoveries([]);
    setSelected(new Set());
    setScanPath(defaultPath);
    onClose();
  };

  const toggleSelect = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === discoveries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(discoveries.map((_, i) => i)));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col glass-card rounded-2xl shadow-xl border border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10">
          <h2 className="font-display text-xl font-semibold">Import Existing Library</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Scan a directory to discover and import audiobooks
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 'input' && (
            <div className="space-y-4">
              <label className="block text-sm font-medium">Directory Path</label>
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <FolderIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={scanPath}
                    onChange={(e) => setScanPath(e.target.value)}
                    placeholder="/path/to/audiobooks"
                    className="w-full pl-10 pr-4 py-2.5 glass-card rounded-xl text-sm focus-ring"
                    onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                  />
                </div>
                <button
                  onClick={handleScan}
                  disabled={!scanPath.trim()}
                  className="px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
                >
                  <SearchIcon className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter the root folder of your audiobook collection. Narratorr will scan for folders containing audio files.
              </p>
            </div>
          )}

          {step === 'scanning' && (
            <div className="flex flex-col items-center justify-center py-12">
              <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
              <p className="text-muted-foreground">Scanning directory...</p>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Found <span className="font-semibold text-foreground">{discoveries.length}</span> audiobook{discoveries.length !== 1 ? 's' : ''}
                  {scanStats.skippedDuplicates > 0 && (
                    <span> ({scanStats.skippedDuplicates} duplicate{scanStats.skippedDuplicates !== 1 ? 's' : ''} skipped)</span>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.size === discoveries.length}
                    onChange={toggleAll}
                    className="rounded"
                  />
                  Select All
                </label>
              </div>

              {discoveries.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No new audiobooks found in this directory.
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {discoveries.map((d, i) => (
                    <label
                      key={d.path}
                      className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-colors ${
                        selected.has(i)
                          ? 'bg-primary/10 border border-primary/30'
                          : 'glass-card hover:border-primary/20'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={() => toggleSelect(i)}
                        className="mt-1 rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{d.parsedTitle}</div>
                        <div className="text-xs text-muted-foreground">
                          {d.parsedAuthor || 'Unknown Author'}
                          {d.parsedSeries && <span> / {d.parsedSeries}</span>}
                        </div>
                        <div className="text-xs text-muted-foreground/60 mt-0.5">
                          {d.fileCount} file{d.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(d.totalSize)}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-12">
              <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
              <p className="text-muted-foreground">
                Importing {selected.size} book{selected.size !== 1 ? 's' : ''}...
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="text-4xl mb-4">
                {importResult.failed === 0 ? '\u2705' : '\u26a0\ufe0f'}
              </div>
              <h3 className="font-display text-lg font-semibold mb-2">Import Complete</h3>
              <p className="text-muted-foreground text-center">
                Imported {importResult.imported} book{importResult.imported !== 1 ? 's' : ''}
                {importResult.failed > 0 && (
                  <span className="text-amber-400">
                    . {importResult.failed} failed.
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
          >
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
          {step === 'review' && discoveries.length > 0 && (
            <button
              onClick={handleConfirm}
              disabled={selected.size === 0}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-50 focus-ring"
            >
              Import {selected.size} Book{selected.size !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
