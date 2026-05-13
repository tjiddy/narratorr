import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { ConfirmModal } from '@/components/ConfirmModal.js';
import { DeleteBookModal } from '@/components/DeleteBookModal.js';
import { RenamePreviewModal } from '@/components/RenamePreviewModal.js';
import { HistoryIcon, BookOpenIcon } from '@/components/icons';
import { Tabs, type TabItem } from '@/components/Tabs.js';
import { MergeStatusIcon } from '@/components/MergeStatusIcon.js';
import type { BookWithAuthor } from '@/lib/api';
import { BookHero } from './BookHero.js';
import { BookDetailsContent } from './BookDetailsContent.js';
import { BookEventHistory } from './BookEventHistory.js';
import { mergeBookData, type MetadataBook } from './helpers.js';
import { useBookActions } from './useBookActions.js';
import { useMergeProgress, type MergeProgress } from '@/hooks/useMergeProgress.js';
import { useBookModals } from '@/hooks/useBookModals.js';
import { formatMergePhase } from '@/lib/format/merge.js';
import { AudioPreview } from './AudioPreview.js';
import { useCoverPaste } from '@/hooks/useCoverPaste.js';
import { useCoverDraft } from '@/hooks/useCoverDraft.js';
import { useRetryImportAvailable } from '@/hooks/useRetryImportAvailable.js';
import { toast } from 'sonner';

const BOOK_TABS: TabItem[] = [
  { value: 'details', label: 'Details', icon: <BookOpenIcon className="w-4 h-4" /> },
  { value: 'history', label: 'History', icon: <HistoryIcon className="w-4 h-4" /> },
];

function canShowWrongRelease(book: BookWithAuthor): boolean {
  return book.status === 'imported' && !!(book.lastGrabGuid || book.lastGrabInfoHash);
}


export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null | undefined;
}) {
  const navigate = useNavigate();
  const { modals, open, close } = useBookModals();
  const [tab, setTab] = useState<'details' | 'history'>('details');

  const merged = mergeBookData(libraryBook, metadataBook);
  const { renameMutation, mergeMutation, cancelMergeMutation, retagMutation, refreshScanMutation, deleteMutation, monitorMutation, wrongReleaseMutation, retryImportMutation, uploadCoverMutation, ffmpegConfigured, isSaving, handleSave } =
    useBookActions(libraryBook.id, libraryBook.monitorForUpgrades);

  const showWrongRelease = canShowWrongRelease(libraryBook);

  const canRetryImport = useRetryImportAvailable(libraryBook.id, libraryBook.status);

  const { previewUrl: coverPreviewUrl, handleCoverFile, handleCoverConfirm, handleCoverCancel } =
    useCoverDraft(uploadCoverMutation);

  useCoverPaste({
    enabled: !!libraryBook.path,
    onPaste: handleCoverFile,
    onError: (msg) => toast.error(msg),
  });

  const mergeProgress = useMergeProgress(libraryBook.id);
  const canMerge = libraryBook.status === 'imported' &&
    (libraryBook.topLevelAudioFileCount ?? 0) >= 2;
  const showRefreshScan = libraryBook.status === 'imported' && !!libraryBook.path;

  return (
    <div className="space-y-6">
      <BookHero
        title={libraryBook.title}
        subtitle={merged.subtitle}
        authorName={merged.authorName}
        authorAsin={merged.authorAsin}
        narratorNames={merged.narratorNames}
        coverUrl={merged.coverUrl}
        updatedAt={libraryBook.updatedAt}
        metaDots={merged.metaDots}
        statusLabel={merged.statusLabel}
        statusDotClass={merged.statusDotClass}
        hasPath={!!libraryBook.path}
        onBackClick={() => navigate(-1)}
        onSearchClick={() => open('search')}
        onEditClick={() => open('edit')}
        onRenameClick={() => open('confirmRename')}
        isRenaming={renameMutation.isPending}
        onRetagClick={() => open('confirmRetag')}
        isRetagging={retagMutation.isPending}
        retagDisabled={!ffmpegConfigured}
        retagTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onRefreshScanClick={() => refreshScanMutation.mutate()}
        isRefreshingScanning={refreshScanMutation.isPending}
        showRefreshScan={showRefreshScan}
        onMergeClick={() => open('confirmMerge')}
        isMerging={mergeMutation.isPending || !!mergeProgress}
        mergePhase={mergeProgress?.phase}
        canMerge={canMerge}
        mergeDisabled={!ffmpegConfigured || !!mergeProgress}
        mergeTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onRemoveClick={() => open('confirmDelete')}
        isRemoving={deleteMutation.isPending}
        showWrongRelease={showWrongRelease}
        onWrongReleaseClick={() => open('confirmWrongRelease')}
        isWrongReleasing={wrongReleaseMutation.isPending}
        importListName={libraryBook.importListName}
        monitorForUpgrades={libraryBook.monitorForUpgrades}
        onMonitorToggle={() => monitorMutation.mutate()}
        isMonitorToggling={monitorMutation.isPending}
        previewUrl={coverPreviewUrl}
        onCoverFileSelect={handleCoverFile}
        onCoverConfirm={handleCoverConfirm}
        onCoverCancel={handleCoverCancel}
        isUploadingCover={uploadCoverMutation.isPending}
        onRetryImportClick={canRetryImport ? () => retryImportMutation.mutate() : undefined}
        isRetryingImport={retryImportMutation.isPending}
      >
        <AudioPreview source={{ kind: 'book', bookId: libraryBook.id, enabled: libraryBook.status === 'imported' && !!libraryBook.path }} />
      </BookHero>

      {mergeProgress && (
        <MergeProgressIndicator
          progress={mergeProgress}
          onCancel={() => cancelMergeMutation.mutate()}
          isCancelling={cancelMergeMutation.isPending}
        />
      )}

      {/* Tab buttons */}
      <div className="flex justify-center animate-fade-in-up stagger-4">
        <Tabs tabs={BOOK_TABS} value={tab} onChange={(v) => setTab(v as 'details' | 'history')} ariaLabel="Book details" />
      </div>

      {/* Tab content */}
      {tab === 'details' && (
        <div role="tabpanel" id="tabpanel-details" aria-labelledby="tab-details">
          <BookDetailsContent libraryBook={libraryBook} merged={merged} />
        </div>
      )}

      {tab === 'history' && (
        <div role="tabpanel" id="tabpanel-history" aria-labelledby="tab-history" className="animate-fade-in-up">
          <BookEventHistory bookId={libraryBook.id} />
        </div>
      )}

      <BookDetailsModals
        libraryBook={libraryBook}
        modals={modals}
        close={close}
        isSaving={isSaving}
        handleSave={handleSave}
        renameMutation={renameMutation}
        retagMutation={retagMutation}
        mergeMutation={mergeMutation}
        wrongReleaseMutation={wrongReleaseMutation}
        deleteMutation={deleteMutation}
        navigate={navigate}
      />
    </div>
  );
}

type BookModalsState = ReturnType<typeof useBookModals>['modals'];
type CloseFn = ReturnType<typeof useBookModals>['close'];
type BookActions = ReturnType<typeof useBookActions>;

function BookDetailsModals({
  libraryBook,
  modals,
  close,
  isSaving,
  handleSave,
  renameMutation,
  retagMutation,
  mergeMutation,
  wrongReleaseMutation,
  deleteMutation,
  navigate,
}: {
  libraryBook: BookWithAuthor;
  modals: BookModalsState;
  close: CloseFn;
  isSaving: boolean;
  handleSave: BookActions['handleSave'];
  renameMutation: BookActions['renameMutation'];
  retagMutation: BookActions['retagMutation'];
  mergeMutation: BookActions['mergeMutation'];
  wrongReleaseMutation: BookActions['wrongReleaseMutation'];
  deleteMutation: BookActions['deleteMutation'];
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <>
      <SearchReleasesModal
        isOpen={modals.search}
        book={libraryBook}
        onClose={() => close('search')}
      />

      {modals.edit && (
        <BookMetadataModal
          book={libraryBook}
          onSave={(data, renameFiles) => handleSave(data, renameFiles, () => close('edit'))}
          onClose={() => close('edit')}
          isSaving={isSaving}
        />
      )}

      {modals.confirmRename && (
        <RenamePreviewModal
          bookId={libraryBook.id}
          isOpen={modals.confirmRename}
          onClose={() => close('confirmRename')}
          onConfirm={() => renameMutation.mutate()}
        />
      )}

      <ConfirmModal
        isOpen={modals.confirmRetag}
        title="Re-tag audio files?"
        message={`Re-tag audio files for "${libraryBook.title}"? This will overwrite existing audio metadata tags. This cannot be undone.`}
        confirmLabel="Re-tag"
        onConfirm={() => { close('confirmRetag'); retagMutation.mutate(); }}
        onCancel={() => close('confirmRetag')}
      />

      <ConfirmModal
        isOpen={modals.confirmMerge}
        title="Merge to M4B?"
        message={`Merge all audio files for "${libraryBook.title}" into a single M4B? Original files will be replaced. This may take several minutes.`}
        confirmLabel="Merge"
        onConfirm={() => { close('confirmMerge'); mergeMutation.mutate(); }}
        onCancel={() => close('confirmMerge')}
      />

      <ConfirmModal
        isOpen={modals.confirmWrongRelease}
        title="Wrong Release?"
        message={`This will delete the files for "${libraryBook.title}", blacklist this release, and search for a new one. This cannot be undone.`}
        confirmLabel="Wrong Release"
        onConfirm={() => { close('confirmWrongRelease'); wrongReleaseMutation.mutate(); }}
        onCancel={() => close('confirmWrongRelease')}
      />

      <DeleteBookModal
        isOpen={modals.confirmDelete}
        title="Remove from Library"
        message={`Are you sure you want to remove "${libraryBook.title}" from your library? This will cancel any active downloads.`}
        fileCount={libraryBook.audioFileCount}
        hasPath={!!libraryBook.path}
        onConfirm={(deleteFiles) => {
          close('confirmDelete');
          deleteMutation.mutate({ deleteFiles }, {
            onSuccess: () => navigate('/library'),
          });
        }}
        onCancel={() => close('confirmDelete')}
      />
    </>
  );
}

const CANCELLABLE_MERGE_PHASES = new Set(['queued', 'starting', 'staging', 'processing', 'verifying']);

function MergeProgressIndicator({ progress, onCancel, isCancelling }: {
  progress: MergeProgress;
  onCancel?: () => void;
  isCancelling?: boolean;
}) {
  const isTerminal = progress.outcome !== undefined;
  const canCancel = !isTerminal && onCancel && CANCELLABLE_MERGE_PHASES.has(progress.phase);
  const percentage = progress.percentage !== undefined ? Math.round(progress.percentage * 100) : undefined;
  return (
    <div
      className={`glass-card rounded-2xl p-4 animate-fade-in-up${isTerminal ? ' animate-fade-out' : ''}`}
      role="status"
      aria-label="Merge progress"
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0 p-2 rounded-xl bg-primary/10">
          <MergeStatusIcon outcome={progress.outcome} phase={progress.phase} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {formatMergePhase(progress.phase, progress.percentage, progress.position)}
          </p>
          {progress.phase === 'processing' && percentage !== undefined && (
            <div
              className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden"
              role="progressbar"
              aria-valuenow={percentage}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${percentage}%` }}
              />
            </div>
          )}
        </div>
        {canCancel && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            onClick={onCancel}
            disabled={isCancelling}
            aria-label="Cancel merge"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

