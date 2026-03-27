import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ImportCard, ImportSummaryBar, BookEditModal } from '@/components/manual-import';
import {
  ArrowLeftIcon,
  CheckIcon,
} from '@/components/icons';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useManualImport } from './useManualImport.js';
import { useFolderHistory } from './useFolderHistory.js';
import { PathStep } from './PathStep.js';
import { isPathInsideLibrary } from './pathUtils.js';

// eslint-disable-next-line complexity -- 3-step page with 21 hook props, path input, and conditional step rendering
export function ManualImportPage() {
  const { data: settings } = useQuery({ queryKey: queryKeys.settings(), queryFn: api.getSettings });

  const folderHistory = useFolderHistory();

  const libraryPath = settings?.library?.path ?? '';

  const { state, actions, mutations, counts } = useManualImport({ onScanSuccess: folderHistory.addRecent, libraryPath });
  const { step, scanPath, setScanPath, scanError, setScanError, rows, mode, setMode, editIndex, setEditIndex, isMatching, progress } = state;
  const { handleScan, handleToggle, handleToggleAll, handleEdit, handleImport, handleBack } = actions;
  const { scanMutation, importMutation } = mutations;
  const { selectedCount, selectedUnmatchedCount, readyCount, reviewCount, noMatchCount, pendingCount, duplicateCount, allSelected } = counts;

  const isInsideLibraryRoot = libraryPath ? isPathInsideLibrary(scanPath, libraryPath) : false;

  // Seed library root as default favorite on first use
  useEffect(() => {
    if (settings?.library?.path) {
      folderHistory.seedLibraryRoot(settings.library.path);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seedLibraryRoot is stable; only re-run when library path changes
  }, [settings?.library?.path]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in-up">
        <div className="flex items-center gap-3 mb-1">
          <button
            type="button"
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
        <PathStep
          scanPath={scanPath}
          setScanPath={setScanPath}
          setScanError={setScanError}
          scanError={scanError}
          handleScan={handleScan}
          isPending={scanMutation.isPending}
          libraryPath={libraryPath}
          isInsideLibraryRoot={isInsideLibraryRoot}
          folderHistory={folderHistory}
        />
      )}

      {/* Step 2: Review Cards */}
      {step === 'review' && (
        <div className="animate-fade-in-up stagger-1">
          <div className="glass-card rounded-xl overflow-hidden">
            {/* Select all header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5">
              <button
                type="button"
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
              duplicateCount={duplicateCount}
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
