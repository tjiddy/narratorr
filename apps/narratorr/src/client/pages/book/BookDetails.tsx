import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { AudioInfo } from '@/components/AudioInfo';
import { BookMetadataModal } from '@/components/book/BookMetadataModal.js';
import { api, type BookWithAuthor, type UpdateBookPayload } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookHero } from './BookHero.js';
import { BookDescription } from './BookDescription.js';
import { FileList } from './FileList.js';
import { mergeBookData, type MetadataBook } from './helpers.js';

export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

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

  const hasDescription = !!merged.description;
  const hasGenres = merged.genres && merged.genres.length > 0;
  const hasFiles = !!libraryBook.path;
  const hasSidebar = libraryBook.audioCodec || hasGenres || hasFiles;

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
      />

      {(hasDescription || hasSidebar) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in-up stagger-5">
          {hasDescription && (
            <div className={hasSidebar ? 'lg:col-span-2' : 'lg:col-span-3'}>
              <BookDescription description={merged.description!} />
            </div>
          )}

          {hasSidebar && (
            <div className={`space-y-6 ${hasDescription ? '' : 'lg:col-span-3 lg:max-w-sm'}`}>
              <AudioInfo book={libraryBook} compact />

              {hasGenres && (
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Genres
                  </h2>
                  <div className="glass-card rounded-2xl p-4">
                    <div className="flex flex-wrap gap-2">
                      {merged.genres!.map((genre) => (
                        <span
                          key={genre}
                          className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {hasFiles && <FileList bookId={libraryBook.id} />}
            </div>
          )}
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
