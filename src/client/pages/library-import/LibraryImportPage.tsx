import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ImportCard, ImportSummaryBar, BookEditModal } from '@/components/manual-import';
import { ArrowLeftIcon, CheckIcon, AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { PageHeader } from '@/components/PageHeader.js';
import { makeRelativePath } from '@/lib/pathUtils.js';
import { useLibraryImport } from './useLibraryImport.js';

// eslint-disable-next-line max-lines-per-function, complexity -- page orchestrator with scan, match, duplicate, register flows
export function LibraryImportPage() {
  const {
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
    registerMutation,
    selectedCount,
    selectedUnmatchedCount,
    selectedPendingCount,
    readyCount,
    reviewCount,
    noMatchCount,
    pendingCount,
    duplicateCount,
    allSelected,
  } = useLibraryImport();

  const [showExisting, setShowExisting] = useState(false);
  const isDbDup = (r: typeof rows[number]) => r.book.isDuplicate && r.book.duplicateReason !== 'within-scan';
  const displayedRows = rows.filter(r => showExisting || !isDbDup(r));
  const rowIndexMap = new Map(rows.map((r, i) => [r, i]));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in-up">
        <div className="flex items-center gap-3 mb-1">
          <Link
            to="/library"
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Back"
          >
            <ArrowLeftIcon className="w-4 h-4" />
          </Link>
          <PageHeader title="Library Import" />
        </div>
        <p className="text-muted-foreground mt-1 ml-10">
          {!hasLibraryPath
            ? 'Configure your library path to scan for existing books'
            : step === 'scanning'
              ? isMatching
                ? `Matching ${progress.matched}/${progress.total}...`
                : 'Scanning library...'
              : `${rows.length} book${rows.length !== 1 ? 's' : ''} found`}
        </p>
      </div>

      {/* No library path configured */}
      {!hasLibraryPath && (
        <div className="glass-card rounded-xl p-8 flex flex-col items-center gap-4 text-center animate-fade-in-up">
          <AlertCircleIcon className="w-10 h-10 text-muted-foreground/50" />
          <div>
            <p className="font-medium mb-1">No library path configured</p>
            <p className="text-sm text-muted-foreground">
              Set a library path in Settings before scanning for existing books.
            </p>
          </div>
          <Link
            to="/settings"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-all focus-ring"
          >
            Go to Settings
          </Link>
        </div>
      )}

      {/* Scanning spinner */}
      {hasLibraryPath && step === 'scanning' && !scanError && (
        <div className="glass-card rounded-xl p-8 flex items-center justify-center gap-3">
          <LoadingSpinner className="w-5 h-5 text-primary" />
          <span className="text-muted-foreground">Scanning library folder...</span>
        </div>
      )}

      {/* Scan error */}
      {scanError && (
        <div className="glass-card rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <AlertCircleIcon className="w-8 h-8 text-red-400" />
          <p className="text-sm text-muted-foreground">{scanError}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      )}

      {/* All caught up — no new books to register */}
      {emptyResult && (
        <div className="glass-card rounded-xl p-8 flex flex-col items-center gap-4 text-center animate-fade-in-up">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <CheckIcon className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="font-medium mb-1">All caught up</p>
            <p className="text-sm text-muted-foreground">
              Your library is up to date — all detected folders are already imported.
            </p>
          </div>
        </div>
      )}

      {/* Match job error */}
      {matchJobError && step === 'review' && !scanError && (
        <div className="glass-card rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <AlertCircleIcon className="w-8 h-8 text-amber-400" />
          <p className="text-sm text-muted-foreground">Matching failed: {matchJobError}</p>
          <button
            type="button"
            onClick={handleRetryMatch}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all focus-ring"
          >
            Retry matching
          </button>
        </div>
      )}

      {/* Review list */}
      {step === 'review' && !scanError && !emptyResult && (
        <div className="animate-fade-in-up stagger-1">
          <div className="glass-card rounded-xl overflow-hidden">
            {/* Select all header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5">
              <button
                type="button"
                onClick={handleSelectAll}
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
                {selectedCount} of {rows.filter(r => !isDbDup(r)).length} new selected
              </span>
              {duplicateCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowExisting(v => !v)}
                  className="text-xs text-muted-foreground/50 ml-auto hover:text-muted-foreground transition-colors"
                >
                  {duplicateCount} existing ({showExisting ? 'shown' : 'hidden'})
                </button>
              )}
            </div>

            {/* Card list */}
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-white/5">
              {displayedRows.map((row) => (
                <ImportCard
                  key={row.book.path}
                  row={row}
                  onToggle={() => handleToggle(rowIndexMap.get(row) ?? -1)}
                  onEdit={() => setEditIndex(rowIndexMap.get(row) ?? -1)}
                  lockDuplicates
                  relativePath={makeRelativePath(row.book.path, libraryRoot ?? '')}
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
              selectedPendingCount={selectedPendingCount}
              duplicateCount={duplicateCount}
              mode="copy"
              onImport={handleRegister}
              importing={registerMutation.isPending}
              hideMode
              disabled={!!matchJobError}
              registerLabel={
                registerMutation.isPending
                  ? 'Importing...'
                  : `Import ${selectedCount} book${selectedCount !== 1 ? 's' : ''}`
              }
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
