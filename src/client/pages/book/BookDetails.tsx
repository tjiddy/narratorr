import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { HistoryIcon, BookOpenIcon } from '@/components/icons';
import type { BookWithAuthor } from '@/lib/api';
import { BookHero } from './BookHero.js';
import { BookDetailsContent } from './BookDetailsContent.js';
import { BookEventHistory } from './BookEventHistory.js';
import { mergeBookData, type MetadataBook } from './helpers.js';
import { useBookActions } from './useBookActions.js';

export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [tab, setTab] = useState<'details' | 'history'>('details');

  const merged = mergeBookData(libraryBook, metadataBook);
  const { renameMutation, retagMutation, monitorMutation, ffmpegConfigured, isSaving, handleSave } =
    useBookActions(libraryBook.id, libraryBook.monitorForUpgrades);

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
        onRenameClick={() => renameMutation.mutate()}
        isRenaming={renameMutation.isPending}
        onRetagClick={() => retagMutation.mutate()}
        isRetagging={retagMutation.isPending}
        retagDisabled={!ffmpegConfigured}
        retagTooltip={!ffmpegConfigured ? 'Requires ffmpeg — configure in Settings > Post Processing' : undefined}
        monitorForUpgrades={libraryBook.monitorForUpgrades}
        onMonitorToggle={() => monitorMutation.mutate()}
        isMonitorToggling={monitorMutation.isPending}
      />

      {/* Tab buttons */}
      <div className="flex justify-center animate-fade-in-up stagger-4">
        <div className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            onClick={() => setTab('details')}
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
            onClick={() => setTab('history')}
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
      {tab === 'details' && <BookDetailsContent libraryBook={libraryBook} merged={merged} />}

      {tab === 'history' && (
        <div className="animate-fade-in-up">
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
    </div>
  );
}
