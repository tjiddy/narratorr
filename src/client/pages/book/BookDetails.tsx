import { useRef, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { ConfirmModal } from '@/components/ConfirmModal.js';
import { DeleteBookModal } from '@/components/DeleteBookModal.js';
import { HistoryIcon, BookOpenIcon } from '@/components/icons';
import { MergeStatusIcon } from '@/components/MergeStatusIcon.js';
import type { BookWithAuthor } from '@/lib/api';
import { BookHero } from './BookHero.js';
import { BookDetailsContent } from './BookDetailsContent.js';
import { BookEventHistory } from './BookEventHistory.js';
import { mergeBookData, type MetadataBook } from './helpers.js';
import { useBookActions } from './useBookActions.js';
import { useMergeProgress, type MergeProgress } from '@/hooks/useMergeProgress.js';
import { formatMergePhase } from '@/lib/format/merge.js';
import { AudioPreview } from './AudioPreview.js';
import { useCoverPaste } from '@/hooks/useCoverPaste.js';
import { toast } from 'sonner';

function getArrowTabIndex(key: string, currentIndex: number, length: number): number | null {
  if (key === 'ArrowRight') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft') return (currentIndex - 1 + length) % length;
  return null;
}

function canShowWrongRelease(book: BookWithAuthor): boolean {
  return book.status === 'imported' && !!(book.lastGrabGuid || book.lastGrabInfoHash);
}

// eslint-disable-next-line max-lines-per-function, complexity -- page orchestrator with multiple confirm modals
export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [confirmRenameOpen, setConfirmRenameOpen] = useState(false);
  const [confirmRetagOpen, setConfirmRetagOpen] = useState(false);
  const [confirmMergeOpen, setConfirmMergeOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmWrongReleaseOpen, setConfirmWrongReleaseOpen] = useState(false);
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = ['details', 'history'] as const;

  const merged = mergeBookData(libraryBook, metadataBook);
  const { renameMutation, mergeMutation, cancelMergeMutation, retagMutation, refreshScanMutation, deleteMutation, monitorMutation, wrongReleaseMutation, uploadCoverMutation, ffmpegConfigured, isSaving, handleSave } =
    useBookActions(libraryBook.id, libraryBook.monitorForUpgrades);

  const showWrongRelease = canShowWrongRelease(libraryBook);

  const handleCoverFile = useCallback((file: File) => {
    const maxSize = 10 * 1024 * 1024;
    if (!file.type.startsWith('image/') || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('Only JPG, PNG, and WebP images are supported');
      return;
    }
    if (file.size > maxSize) {
      toast.error('Cover image must be under 10 MB');
      return;
    }
    // Revoke previous preview URL if replacing
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    setCoverFile(file);
    setCoverPreviewUrl(URL.createObjectURL(file));
  }, [coverPreviewUrl]);

  const handleCoverConfirm = useCallback(() => {
    if (!coverFile) return;
    uploadCoverMutation.mutate(coverFile, {
      onSuccess: () => {
        // Keep preview visible until query refetch brings the new URL,
        // preventing a flash of the old cached cover between clearing
        // the blob preview and the cache-busted new image loading.
        if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
        setCoverPreviewUrl(null);
        setCoverFile(null);
      },
    });
  }, [coverFile, coverPreviewUrl, uploadCoverMutation]);

  const handleCoverCancel = useCallback(() => {
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    setCoverPreviewUrl(null);
    setCoverFile(null);
  }, [coverPreviewUrl]);

  // Clean up object URL on unmount
  useEffect(() => {
    return () => {
      if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    };
  }, [coverPreviewUrl]);

  useCoverPaste({
    enabled: !!libraryBook.path,
    onPaste: handleCoverFile,
    onError: (msg) => toast.error(msg),
  });

  const mergeProgress = useMergeProgress(libraryBook.id);
  const canMerge = libraryBook.status === 'imported' &&
    (libraryBook.topLevelAudioFileCount ?? 0) >= 2;
  const showRefreshScan = libraryBook.status === 'imported' && !!libraryBook.path;

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const nextIndex = getArrowTabIndex(e.key, tabs.indexOf(tab), tabs.length);
    if (nextIndex !== null) {
      e.preventDefault();
      setTab(tabs[nextIndex]);
      tabRefs.current[nextIndex]?.focus();
    }
  }

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
        onSearchClick={() => setSearchModalOpen(true)}
        onEditClick={() => setEditModalOpen(true)}
        onRenameClick={() => setConfirmRenameOpen(true)}
        isRenaming={renameMutation.isPending}
        onRetagClick={() => setConfirmRetagOpen(true)}
        isRetagging={retagMutation.isPending}
        retagDisabled={!ffmpegConfigured}
        retagTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onRefreshScanClick={() => refreshScanMutation.mutate()}
        isRefreshingScanning={refreshScanMutation.isPending}
        showRefreshScan={showRefreshScan}
        onMergeClick={() => setConfirmMergeOpen(true)}
        isMerging={mergeMutation.isPending || !!mergeProgress}
        mergePhase={mergeProgress?.phase}
        canMerge={canMerge}
        mergeDisabled={!ffmpegConfigured || !!mergeProgress}
        mergeTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onRemoveClick={() => setConfirmDeleteOpen(true)}
        isRemoving={deleteMutation.isPending}
        showWrongRelease={showWrongRelease}
        onWrongReleaseClick={() => setConfirmWrongReleaseOpen(true)}
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
      >
        <AudioPreview bookId={libraryBook.id} status={libraryBook.status} path={libraryBook.path ?? null} />
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
        <div role="tablist" aria-label="Book details" className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            ref={(el) => { tabRefs.current[0] = el; }}
            id="tab-details"
            role="tab"
            aria-selected={tab === 'details'}
            aria-controls="tabpanel-details"
            tabIndex={tab === 'details' ? 0 : -1}
            onClick={() => setTab('details')}
            onKeyDown={handleTabKeyDown}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'details'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BookOpenIcon className="w-4 h-4" />
            Details
          </button>
          <button
            ref={(el) => { tabRefs.current[1] = el; }}
            id="tab-history"
            role="tab"
            aria-selected={tab === 'history'}
            aria-controls="tabpanel-history"
            tabIndex={tab === 'history' ? 0 : -1}
            onClick={() => setTab('history')}
            onKeyDown={handleTabKeyDown}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'history'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <HistoryIcon className="w-4 h-4" />
            History
          </button>
        </div>
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

      <SearchReleasesModal
        isOpen={searchModalOpen}
        book={libraryBook}
        onClose={() => setSearchModalOpen(false)}
      />

      {editModalOpen && (
        <BookMetadataModal
          book={libraryBook}
          onSave={(data, renameFiles) => handleSave(data, renameFiles, () => setEditModalOpen(false))}
          onClose={() => setEditModalOpen(false)}
          isSaving={isSaving}
        />
      )}

      <ConfirmModal
        isOpen={confirmRenameOpen}
        title="Rename files?"
        message={`Rename files for "${libraryBook.title}"? This will move files to match your folder format template. This cannot be undone.`}
        confirmLabel="Rename"
        onConfirm={() => { setConfirmRenameOpen(false); renameMutation.mutate(); }}
        onCancel={() => setConfirmRenameOpen(false)}
      />

      <ConfirmModal
        isOpen={confirmRetagOpen}
        title="Re-tag audio files?"
        message={`Re-tag audio files for "${libraryBook.title}"? This will overwrite existing audio metadata tags. This cannot be undone.`}
        confirmLabel="Re-tag"
        onConfirm={() => { setConfirmRetagOpen(false); retagMutation.mutate(); }}
        onCancel={() => setConfirmRetagOpen(false)}
      />

      <ConfirmModal
        isOpen={confirmMergeOpen}
        title="Merge to M4B?"
        message={`Merge all audio files for "${libraryBook.title}" into a single M4B? Original files will be replaced. This may take several minutes.`}
        confirmLabel="Merge"
        onConfirm={() => { setConfirmMergeOpen(false); mergeMutation.mutate(); }}
        onCancel={() => setConfirmMergeOpen(false)}
      />

      <ConfirmModal
        isOpen={confirmWrongReleaseOpen}
        title="Wrong Release?"
        message={`This will delete the files for "${libraryBook.title}", blacklist this release, and search for a new one. This cannot be undone.`}
        confirmLabel="Wrong Release"
        onConfirm={() => { setConfirmWrongReleaseOpen(false); wrongReleaseMutation.mutate(); }}
        onCancel={() => setConfirmWrongReleaseOpen(false)}
      />

      <DeleteBookModal
        isOpen={confirmDeleteOpen}
        title="Remove from Library"
        message={`Are you sure you want to remove "${libraryBook.title}" from your library? This will cancel any active downloads.`}
        fileCount={libraryBook.audioFileCount}
        hasPath={!!libraryBook.path}
        onConfirm={(deleteFiles) => {
          setConfirmDeleteOpen(false);
          deleteMutation.mutate({ deleteFiles }, {
            onSuccess: () => navigate('/library'),
          });
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
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

