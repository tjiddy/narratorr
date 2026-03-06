import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { HistoryIcon, BookOpenIcon } from '@/components/icons';
import { api, type BookWithAuthor, type UpdateBookPayload } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookHero } from './BookHero.js';
import { BookDetailsContent } from './BookDetailsContent.js';
import { BookEventHistory } from './BookEventHistory.js';
import { mergeBookData, type MetadataBook } from './helpers.js';

// eslint-disable-next-line max-lines-per-function -- orchestrates multiple mutations + modal states for book detail page
export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [tab, setTab] = useState<'details' | 'history'>('details');

  const merged = mergeBookData(libraryBook, metadataBook);

  const invalidateBookQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.book(libraryBook.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.bookFiles(libraryBook.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.books() });
  };

  const renameMutation = useMutation({
    mutationFn: () => api.renameBook(libraryBook.id),
    onSuccess: (result) => {
      invalidateBookQueries();
      toast.success(result.message);
    },
    onError: (error: Error) => {
      toast.error(`Rename failed: ${error.message}`);
    },
  });

  const retagMutation = useMutation({
    mutationFn: () => api.retagBook(libraryBook.id),
    onSuccess: (result) => {
      const msg = `Tagged ${result.tagged} file${result.tagged !== 1 ? 's' : ''}`;
      if (result.failed > 0) {
        toast.warning(`${msg}, ${result.failed} failed`);
      } else {
        toast.success(msg);
      }
    },
    onError: (error: Error) => {
      toast.error(`Re-tag failed: ${error.message}`);
    },
  });

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const ffmpegConfigured = !!settings?.processing?.ffmpegPath?.trim();

  const monitorMutation = useMutation({
    mutationFn: () => api.updateBook(libraryBook.id, { monitorForUpgrades: !libraryBook.monitorForUpgrades }),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success(libraryBook.monitorForUpgrades ? 'Upgrade monitoring disabled' : 'Upgrade monitoring enabled');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${error.message}`);
    },
  });

  const handleSave = async (data: UpdateBookPayload, renameFiles: boolean) => {
    setIsSaving(true);
    try {
      await api.updateBook(libraryBook.id, data);
      invalidateBookQueries();
      setEditModalOpen(false);
      toast.success('Metadata updated');

      if (renameFiles) {
        try {
          const renameResult = await api.renameBook(libraryBook.id);
          invalidateBookQueries();
          toast.success(renameResult.message);
        } catch (renameError) {
          toast.error(`Rename failed: ${renameError instanceof Error ? renameError.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      toast.error(`Failed to update book: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

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
          onSave={handleSave}
          onClose={() => setEditModalOpen(false)}
          isSaving={isSaving}
        />
      )}
    </div>
  );
}
