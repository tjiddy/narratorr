import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { ConfirmModal } from '@/components/ConfirmModal.js';
import { DeleteBookModal } from '@/components/DeleteBookModal.js';
import { HistoryIcon, BookOpenIcon, RefreshIcon } from '@/components/icons';
import type { BookWithAuthor } from '@/lib/api';
import { BookHero } from './BookHero.js';
import { BookDetailsContent } from './BookDetailsContent.js';
import { BookEventHistory } from './BookEventHistory.js';
import { mergeBookData, type MetadataBook } from './helpers.js';
import { useBookActions } from './useBookActions.js';
import { useMergeProgress } from '@/hooks/useMergeProgress.js';

function getArrowTabIndex(key: string, currentIndex: number, length: number): number | null {
  if (key === 'ArrowRight') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft') return (currentIndex - 1 + length) % length;
  return null;
}

// eslint-disable-next-line max-lines-per-function -- page orchestrator with multiple confirm modals
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
  const [tab, setTab] = useState<'details' | 'history'>('details');

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = ['details', 'history'] as const;

  const merged = mergeBookData(libraryBook, metadataBook);
  const { renameMutation, mergeMutation, retagMutation, deleteMutation, monitorMutation, ffmpegConfigured, isSaving, handleSave } =
    useBookActions(libraryBook.id, libraryBook.monitorForUpgrades);

  const mergeProgress = useMergeProgress(libraryBook.id);
  const canMerge = libraryBook.status === 'imported' &&
    (libraryBook.topLevelAudioFileCount ?? 0) >= 2;

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
        metaDots={merged.metaDots}
        statusLabel={merged.statusLabel}
        statusDotClass={merged.statusDotClass}
        hasPath={!!libraryBook.path}
        onBackClick={() => navigate('/library')}
        onSearchClick={() => setSearchModalOpen(true)}
        onEditClick={() => setEditModalOpen(true)}
        onRenameClick={() => setConfirmRenameOpen(true)}
        isRenaming={renameMutation.isPending}
        onRetagClick={() => setConfirmRetagOpen(true)}
        isRetagging={retagMutation.isPending}
        retagDisabled={!ffmpegConfigured}
        retagTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onMergeClick={() => setConfirmMergeOpen(true)}
        isMerging={mergeMutation.isPending || !!mergeProgress}
        canMerge={canMerge}
        mergeDisabled={!ffmpegConfigured || !!mergeProgress}
        mergeTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        onRemoveClick={() => setConfirmDeleteOpen(true)}
        isRemoving={deleteMutation.isPending}
        importListName={libraryBook.importListName}
        monitorForUpgrades={libraryBook.monitorForUpgrades}
        onMonitorToggle={() => monitorMutation.mutate()}
        isMonitorToggling={monitorMutation.isPending}
      />

      {mergeProgress && <MergeProgressIndicator progress={mergeProgress} />}

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

function MergeProgressIndicator({ progress }: { progress: { phase: string; percentage?: number } }) {
  return (
    <div className="glass-card rounded-2xl p-4 animate-fade-in-up" role="status" aria-label="Merge progress">
      <div className="flex items-center gap-3">
        <div className="shrink-0 p-2 rounded-xl bg-primary/10">
          <RefreshIcon className="w-4 h-4 text-primary animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {formatMergePhase(progress.phase, progress.percentage)}
          </p>
          {progress.phase === 'processing' && progress.percentage !== undefined && (
            <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${Math.round(progress.percentage * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatMergePhase(phase: string, percentage?: number): string {
  switch (phase) {
    case 'starting': return 'Merge started...';
    case 'staging': return 'Staging files...';
    case 'processing':
      return percentage !== undefined
        ? `Encoding to M4B — ${Math.round(percentage * 100)}%...`
        : 'Encoding to M4B...';
    case 'verifying': return 'Verifying output...';
    case 'finalizing': return 'Finalizing...';
    default: return 'Merging...';
  }
}
