import { useState } from 'react';
import { Link } from 'react-router';
import { ImportCard, ImportSummaryBar, BookEditModal, MatchPausedBanner } from '@/components/manual-import';
import { HeldReviewPanel } from '@/components/held-review';
import { ArrowLeftIcon, CheckIcon, AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { PageHeader } from '@/components/PageHeader.js';
import { makeRelativePath } from '@/lib/pathUtils.js';
import { useLibraryImport } from './useLibraryImport.js';
import { isLibraryDbDuplicate } from './isLibraryDbDuplicate.js';
import { libraryImportSection } from './libraryImportSection.js';
import { DuplicateCopiesSection } from './DuplicateCopiesSection.js';
import { LastImportPanel } from '@/components/import-report/LastImportPanel';
import { ImportAttentionBanner } from '@/components/import-report/ImportAttentionBanner';
import { StagedSubmitBanner } from '@/components/import-report/StagedSubmitBanner';

// eslint-disable-next-line max-lines-per-function, complexity -- page orchestrator with scan, match, duplicate, register flows
export function LibraryImportPage() {
  const { state, actions, mutations, counts } = useLibraryImport();
  const {
    step, hasLibraryPath, scanError, emptyResult, rows, editIndex, setEditIndex, isMatching, progress,
    chunkProgress, libraryRoot, heldReview, banner, dismissBanner, recovering, paused, pausedReason, matchRemaining, matchTotal,
  } = state;
  const {
    handleToggle, handleSelectAll, handleEdit, handleRegister, handleReconfirmHeld, handleRetry,
    handleRestartMatch, handleResumeMatch, handleDeselectPending,
  } = actions;
  const { registerMutation } = mutations;
  const {
    selectedCount, selectedUnmatchedCount, selectedPendingCount, readyCount, reviewCount, noMatchCount, pendingCount,
    duplicateCount, pathDuplicateCount, copyDuplicateCount, allSelected,
  } = counts;

  const [showExisting, setShowExisting] = useState(false);
  // Section membership is presentational only; `isLibraryDbDuplicate` still owns eligibility.
  const sectionOf = (row: typeof rows[number]) => libraryImportSection(row.book);
  const mainRows = rows.filter(r => sectionOf(r) === 'new' || (showExisting && sectionOf(r) === 'existing-path'));
  const copyRows = rows.filter(r => sectionOf(r) === 'duplicate-copy');
  const rowIndexMap = new Map(rows.map((r, i) => [r, i]));

  return (
    <div className="space-y-6">
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

      <StagedSubmitBanner message={banner} onDismiss={dismissBanner} />

      <LastImportPanel source="library" />
      <ImportAttentionBanner source="library" onImportAgain={() => handleRetry()} />

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

      {hasLibraryPath && step === 'scanning' && !scanError && (
        <div className="glass-card rounded-xl p-8 flex items-center justify-center gap-3">
          <LoadingSpinner className="w-5 h-5 text-primary" />
          <span className="text-muted-foreground">Scanning library folder...</span>
        </div>
      )}

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

      {paused && pausedReason && step === 'review' && !scanError && (
        <MatchPausedBanner
          reason={pausedReason}
          remaining={matchRemaining}
          total={matchTotal}
          onResume={handleResumeMatch}
          onRestart={handleRestartMatch}
          busy={recovering}
        />
      )}

      <HeldReviewPanel
        heldReview={heldReview}
        onReconfirm={handleReconfirmHeld}
        isPending={registerMutation.isPending}
      />

      {step === 'review' && !scanError && !emptyResult && (
        <div className="animate-fade-in-up stagger-1">
          <div className="glass-card rounded-xl overflow-hidden">
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
                {selectedCount} of {rows.filter(r => !isLibraryDbDuplicate(r.book)).length} new selected
              </span>
              {/* Keep this affordance page-local; MatchPausedBanner is shared with Manual Import. */}
              {paused && selectedPendingCount > 0 && (
                <button
                  type="button"
                  onClick={handleDeselectPending}
                  className="text-xs font-medium text-primary/80 hover:text-primary transition-colors focus-ring rounded"
                >
                  Deselect {selectedPendingCount} pending
                </button>
              )}
              {/* #2091: the toggle counts only folders that ARE a book's own path. Copies at
                  other paths get their own always-visible section and their own count. */}
              {copyDuplicateCount > 0 && (
                <span className="text-xs text-amber-500/80" data-testid="copy-duplicate-count">
                  {copyDuplicateCount} duplicate cop{copyDuplicateCount === 1 ? 'y' : 'ies'}
                </span>
              )}
              {pathDuplicateCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowExisting(v => !v)}
                  className="text-xs text-muted-foreground/50 ml-auto hover:text-muted-foreground transition-colors"
                >
                  {pathDuplicateCount} existing ({showExisting ? 'shown' : 'hidden'})
                </button>
              )}
            </div>

            <div className="max-h-[55vh] overflow-y-auto divide-y divide-white/5">
              {mainRows.map((row) => (
                <ImportCard
                  key={row.book.path}
                  row={row}
                  onToggle={() => handleToggle(rowIndexMap.get(row) ?? -1)}
                  onEdit={() => setEditIndex(rowIndexMap.get(row) ?? -1)}
                  lockDuplicates
                  relativePath={makeRelativePath(row.book.path, libraryRoot ?? '')}
                  paused={paused}
                />
              ))}
            </div>

            <DuplicateCopiesSection
              rows={copyRows}
              libraryRoot={libraryRoot ?? ''}
              onEdit={(row) => setEditIndex(rowIndexMap.get(row) ?? -1)}
              paused={paused}
            />

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
              paused={paused}
              // Paused imports rely on selection counts; recovery remains fail-closed.
              disabled={recovering}
              registerLabel={
                registerMutation.isPending
                  ? (chunkProgress && chunkProgress.chunks > 1
                      ? `Registering ${chunkProgress.current} of ${chunkProgress.total}…`
                      : 'Importing...')
                  : `Import ${selectedCount} book${selectedCount !== 1 ? 's' : ''}`
              }
            />
          </div>
        </div>
      )}

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
