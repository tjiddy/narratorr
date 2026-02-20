import { ImportCard, ImportSummaryBar, BookEditModal } from '@/components/manual-import';
import {
  FolderIcon,
  AlertCircleIcon,
  LoadingSpinner,
  ArrowLeftIcon,
  CheckIcon,
} from '@/components/icons';
import { useManualImport } from './useManualImport.js';

// eslint-disable-next-line complexity
export function ManualImportPage() {
  const {
    step, scanPath, setScanPath, scanError, setScanError, rows,
    mode, setMode, editIndex, setEditIndex, skippedDuplicates,
    isMatching, progress,
    handleScan, handleToggle, handleToggleAll, handleEdit, handleImport, handleBack,
    scanMutation, importMutation,
    selectedCount, selectedUnmatchedCount, readyCount, reviewCount,
    noMatchCount, pendingCount, allSelected,
  } = useManualImport();

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
