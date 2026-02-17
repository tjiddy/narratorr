import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, formatBytes, type BookMetadata, type ImportConfirmItem, type SingleBookResult } from '@/lib/api';
import { isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { useLibrary } from '@/hooks/useLibrary';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { FolderIcon, SearchIcon, LoadingSpinner, CheckCircleIcon, AlertCircleIcon, BookOpenIcon, XIcon, HeadphonesIcon, PencilIcon } from '@/components/icons';

interface QuickAddWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 'path' | 'scanning' | 'verify' | 'importing' | 'done';

const STEP_INDEX: Record<Step, number> = { path: 0, scanning: 0, verify: 1, importing: 1, done: 2 };
const STEP_LABELS = ['Locate', 'Verify', 'Import'];

export function QuickAddWizard({ isOpen, onClose }: QuickAddWizardProps) {
  const queryClient = useQueryClient();
  const { data: libraryBooks } = useLibrary();
  const modalRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>('path');
  const [scanPath, setScanPath] = useState('');
  const [scanResult, setScanResult] = useState<SingleBookResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Editable fields for verify step
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [series, setSeries] = useState('');
  const [selectedMetadata, setSelectedMetadata] = useState<BookMetadata | null>(null);

  // Search results for re-search
  const [searchResults, setSearchResults] = useState<BookMetadata[]>([]);

  // Import result
  const [importSuccess, setImportSuccess] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleClose = () => {
    setStep('path');
    setScanPath('');
    setScanResult(null);
    setScanError(null);
    setTitle('');
    setAuthor('');
    setSeries('');
    setSelectedMetadata(null);
    setSearchResults([]);
    setImportSuccess(false);
    setImportError(null);
    onClose();
  };

  useEscapeKey(isOpen, handleClose, modalRef);

  const scanMutation = useMutation({
    mutationFn: (path: string) => api.scanSingleBook(path),
    onSuccess: (result) => {
      setScanResult(result);
      setScanError(null);

      // Start with folder-parsed values
      const parsedAuthor = result.book.parsedAuthor || '';
      const parsedSeries = result.book.parsedSeries || '';
      setTitle(result.book.parsedTitle);
      setAuthor(parsedAuthor);
      setSeries(parsedSeries);

      // Fill gaps from metadata provider match
      setSelectedMetadata(result.metadata);
      if (result.metadata) {
        setSearchResults([result.metadata]);
        if (!parsedAuthor && result.metadata.authors?.[0]?.name) {
          setAuthor(result.metadata.authors[0].name);
        }
        if (!parsedSeries && result.metadata.series?.[0]?.name) {
          setSeries(result.metadata.series[0].name);
        }
      }
      setStep('verify');
    },
    onError: (error: Error) => {
      setScanError(error.message);
      setStep('path');
    },
  });

  const searchMutation = useMutation({
    mutationFn: (query: string) => api.searchMetadata(query),
    onSuccess: (result) => {
      setSearchResults(result.books);
      // Only update the metadata preview — don't touch title/author/series
      // since the user explicitly typed those to trigger this search
      if (result.books.length > 0) {
        setSelectedMetadata(result.books[0]);
      } else {
        setSelectedMetadata(null);
      }
    },
  });

  const importMutation = useMutation({
    mutationFn: (item: ImportConfirmItem) => api.importSingleBook(item),
    onSuccess: (result) => {
      if (result.imported) {
        setImportSuccess(true);
        setImportError(null);
        queryClient.invalidateQueries({ queryKey: queryKeys.books() });
        toast.success(`Added "${title}" to library`);
      } else {
        setImportSuccess(false);
        setImportError(result.error === 'duplicate' ? 'This book is already in your library.' : 'Import failed.');
      }
      setStep('done');
    },
    onError: (error: Error) => {
      setImportSuccess(false);
      setImportError(error.message);
      setStep('done');
    },
  });

  const applyMetadata = (meta: BookMetadata) => {
    setSelectedMetadata(meta);
    setTitle(meta.title);
    if (meta.authors?.[0]?.name) {
      setAuthor(meta.authors[0].name);
    }
    setSeries(meta.series?.[0]?.name ?? '');
  };

  const handleScan = () => {
    if (!scanPath.trim()) return;
    setScanError(null);
    setStep('scanning');
    scanMutation.mutate(scanPath.trim());
  };

  const handleSearch = () => {
    const query = [title, author].filter(Boolean).join(' ');
    if (query) {
      searchMutation.mutate(query);
    }
  };

  const handleImport = () => {
    if (!scanResult || !title.trim()) return;
    setStep('importing');
    importMutation.mutate({
      path: scanResult.book.path,
      title: title.trim(),
      authorName: author.trim() || undefined,
      seriesName: series.trim() || undefined,
      coverUrl: selectedMetadata?.coverUrl,
      asin: selectedMetadata?.asin,
      metadata: selectedMetadata ?? undefined,
    });
  };

  if (!isOpen) return null;

  const currentStep = STEP_INDEX[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick Add audiobook"
        className="relative w-full max-w-xl flex flex-col glass-card rounded-2xl shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-start justify-between">
          <div className="space-y-3">
            <h2 className="font-display text-xl font-semibold tracking-tight">Quick Add</h2>
            {/* Step indicator */}
            <div className="flex items-center gap-1.5">
              {STEP_LABELS.map((label, i) => (
                <div key={label} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <div className={`w-6 h-px transition-colors duration-300 ${i <= currentStep ? 'bg-primary/60' : 'bg-border/50'}`} />
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className={`
                      w-5 h-5 rounded-full text-[10px] font-semibold flex items-center justify-center transition-all duration-300
                      ${i < currentStep
                        ? 'bg-primary text-primary-foreground'
                        : i === currentStep
                          ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                          : 'bg-muted/50 text-muted-foreground/50'
                      }
                    `}>
                      {i < currentStep ? '\u2713' : i + 1}
                    </div>
                    <span className={`text-xs font-medium transition-colors duration-300 ${
                      i <= currentStep ? 'text-foreground' : 'text-muted-foreground/50'
                    }`}>
                      {label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="border-t border-white/5" />

        {/* Content */}
        <div className="p-6">
          {/* Step 1: Path */}
          {step === 'path' && (
            <div className="space-y-4">
              <div className="relative">
                <FolderIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={scanPath}
                  onChange={(e) => { setScanPath(e.target.value); setScanError(null); }}
                  placeholder="/path/to/audiobook"
                  className="w-full pl-10 pr-4 py-2.5 glass-card rounded-xl text-sm focus-ring"
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
              <p className="text-xs text-muted-foreground/70">
                Point to a folder containing audiobook files (mp3, m4b, flac, etc.)
              </p>
            </div>
          )}

          {/* Scanning */}
          {step === 'scanning' && (
            <div className="flex flex-col items-center justify-center py-16">
              <LoadingSpinner className="w-7 h-7 text-primary mb-4" />
              <p className="text-sm text-muted-foreground">Scanning folder&hellip;</p>
            </div>
          )}

          {/* Step 2: Verify */}
          {step === 'verify' && scanResult && (
            <div className="space-y-5">
              {/* Metadata preview card */}
              <div className="flex gap-4">
                {/* Cover */}
                <div className="w-[88px] h-[120px] shrink-0 rounded-lg overflow-hidden bg-muted/50 relative">
                  {selectedMetadata?.coverUrl ? (
                    <img
                      src={selectedMetadata.coverUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted/80 to-muted/30">
                      <BookOpenIcon className="w-7 h-7 text-muted-foreground/20" />
                    </div>
                  )}
                  <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-lg" />
                </div>

                {/* Metadata details */}
                <div className="flex-1 min-w-0 py-0.5">
                  {selectedMetadata ? (
                    <div className="space-y-1.5">
                      <div className="flex items-start gap-2">
                        <p className="text-sm font-semibold leading-tight line-clamp-2 flex-1">{selectedMetadata.title}</p>
                        {isBookInLibrary(selectedMetadata, libraryBooks) && (
                          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
                            <CheckCircleIcon className="w-3 h-3" />
                            In library
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {selectedMetadata.authors?.map(a => a.name).join(', ')}
                      </p>
                      {selectedMetadata.narrators && selectedMetadata.narrators.length > 0 && (
                        <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                          <HeadphonesIcon className="w-3 h-3 shrink-0" />
                          {selectedMetadata.narrators.join(', ')}
                        </p>
                      )}
                      {selectedMetadata.description && (
                        <p className="text-xs text-muted-foreground/60 line-clamp-2 leading-relaxed">
                          {selectedMetadata.description}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 text-sm text-muted-foreground py-1">
                      <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-400/80" />
                      <span className="text-xs leading-relaxed">No metadata match found. Edit fields below and search again.</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Editable fields */}
              <div className="space-y-3">
                <div>
                  <label htmlFor="qa-title" className="block text-xs font-medium text-muted-foreground mb-1.5">Title</label>
                  <input
                    id="qa-title"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="qa-author" className="block text-xs font-medium text-muted-foreground mb-1.5">Author</label>
                    <input
                      id="qa-author"
                      type="text"
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                    />
                  </div>
                  <div>
                    <label htmlFor="qa-series" className="block text-xs font-medium text-muted-foreground mb-1.5">Series</label>
                    <input
                      id="qa-series"
                      type="text"
                      value={series}
                      onChange={(e) => setSeries(e.target.value)}
                      className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                    />
                  </div>
                </div>
              </div>

              {/* File info + search row */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground/50">
                  {scanResult.book.fileCount} file{scanResult.book.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(scanResult.book.totalSize)}
                </span>
                <button
                  onClick={handleSearch}
                  disabled={searchMutation.isPending || (!title.trim() && !author.trim())}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium glass-card rounded-lg hover:border-primary/30 hover:text-primary transition-all disabled:opacity-40 focus-ring"
                >
                  {searchMutation.isPending ? (
                    <LoadingSpinner className="w-3 h-3" />
                  ) : (
                    <SearchIcon className="w-3 h-3" />
                  )}
                  Search Providers
                </button>
              </div>

              {/* Alternative search results */}
              {searchResults.length > 1 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground/70">Other matches</p>
                  <div className="max-h-32 overflow-y-auto space-y-1 -mx-1 px-1">
                    {searchResults.slice(1, 5).map((meta, i) => (
                      <button
                        key={meta.providerId || i}
                        onClick={() => applyMetadata(meta)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left rounded-xl hover:bg-muted/40 transition-colors group"
                      >
                        <div className="w-8 h-8 shrink-0 rounded overflow-hidden bg-muted/30 relative">
                          {meta.coverUrl ? (
                            <img src={meta.coverUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <BookOpenIcon className="w-3 h-3 text-muted-foreground/20" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{meta.title}</p>
                          <p className="text-xs text-muted-foreground/60 truncate flex items-center gap-1">
                            <PencilIcon className="w-2.5 h-2.5 shrink-0" />
                            {meta.authors?.map(a => a.name).join(', ')}
                          </p>
                          {meta.narrators?.length ? (
                            <p className="text-xs text-muted-foreground/40 truncate flex items-center gap-1">
                              <HeadphonesIcon className="w-2.5 h-2.5 shrink-0" />
                              {meta.narrators.join(', ')}
                            </p>
                          ) : null}
                        </div>
                        {isBookInLibrary(meta, libraryBooks) && (
                          <CheckCircleIcon className="w-3.5 h-3.5 shrink-0 text-emerald-400/70" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Importing */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-16">
              <LoadingSpinner className="w-7 h-7 text-primary mb-4" />
              <p className="text-sm text-muted-foreground">
                Importing <span className="text-foreground font-medium">{title}</span>&hellip;
              </p>
            </div>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-14">
              {importSuccess ? (
                <>
                  <div className="relative mb-5">
                    <div className="absolute inset-0 bg-emerald-500/20 rounded-full blur-xl" />
                    <CheckCircleIcon className="relative w-10 h-10 text-emerald-400" />
                  </div>
                  <h3 className="font-display text-lg font-semibold mb-1">Added to Library</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-xs">
                    <span className="text-foreground font-medium">{title}</span> has been imported and enriched.
                  </p>
                </>
              ) : (
                <>
                  <div className="relative mb-5">
                    <div className="absolute inset-0 bg-amber-500/20 rounded-full blur-xl" />
                    <AlertCircleIcon className="relative w-10 h-10 text-amber-400" />
                  </div>
                  <h3 className="font-display text-lg font-semibold mb-1">Import Failed</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-xs">{importError}</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3">
          {step === 'path' && (
            <button
              onClick={handleScan}
              disabled={!scanPath.trim()}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              Scan
            </button>
          )}
          {step === 'verify' && (
            <>
              <button
                onClick={() => { setStep('path'); setScanError(null); }}
                className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={!title.trim()}
                className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 hover:shadow-glow transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
              >
                Import
              </button>
            </>
          )}
          {step === 'done' && (
            <button
              onClick={handleClose}
              className="px-5 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
