import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { AudioInfo } from '@/components/AudioInfo';
import type { BookWithAuthor } from '@/lib/api';
import { BookHero } from './BookHero.js';
import { BookDescription } from './BookDescription.js';
import { mergeBookData, type MetadataBook } from './helpers.js';

export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  const merged = mergeBookData(libraryBook, metadataBook);

  return (
    <div className="space-y-8">
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
        onBackClick={() => navigate('/library')}
        onSearchClick={() => setSearchModalOpen(true)}
      />

      {merged.description && <BookDescription description={merged.description} />}

      <AudioInfo book={libraryBook} />

      {merged.genres && merged.genres.length > 0 && (
        <div className="animate-fade-in-up stagger-6">
          <div className="flex flex-wrap gap-2">
            {merged.genres.map((genre) => (
              <span
                key={genre}
                className="glass-card rounded-xl px-3 py-1.5 text-xs font-medium"
              >
                {genre}
              </span>
            ))}
          </div>
        </div>
      )}

      <SearchReleasesModal
        isOpen={searchModalOpen}
        book={libraryBook}
        onClose={() => setSearchModalOpen(false)}
      />
    </div>
  );
}
