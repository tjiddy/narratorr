import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { formatDuration } from '@/lib/helpers';
import { bookStatusConfig } from '@/lib/status';
import { ArrowLeftIcon, SearchIcon, BookOpenIcon } from '@/components/icons';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { AudioInfo } from '@/components/AudioInfo';
import type { BookWithAuthor } from '@/lib/api';

const DESCRIPTION_COLLAPSE_LENGTH = 300;

interface MetadataBook {
  subtitle?: string;
  description?: string;
  coverUrl?: string;
  duration?: number;
  genres?: string[];
  narrators?: string[];
  publisher?: string;
  series?: { name: string; position?: number }[];
}

// eslint-disable-next-line max-lines-per-function, complexity
export function BookDetails({ libraryBook, metadataBook }: {
  libraryBook: BookWithAuthor;
  metadataBook?: MetadataBook | null;
}) {
  const navigate = useNavigate();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  // Merge: library data is primary, metadata supplements
  const title = libraryBook.title;
  const authorName = libraryBook.author?.name;
  const subtitle = metadataBook?.subtitle;
  const narratorNames = libraryBook.narrator || metadataBook?.narrators?.join(', ');
  const description = libraryBook.description || metadataBook?.description;
  const coverUrl = libraryBook.coverUrl || metadataBook?.coverUrl;
  const duration = formatDuration(libraryBook.duration ?? metadataBook?.duration);
  const genres = libraryBook.genres ?? metadataBook?.genres;
  const seriesName = libraryBook.seriesName || metadataBook?.series?.[0]?.name;
  const seriesPosition = libraryBook.seriesPosition ?? metadataBook?.series?.[0]?.position;
  const publisher = metadataBook?.publisher;
  const status = bookStatusConfig[libraryBook.status] ?? bookStatusConfig.wanted;

  const descriptionLong = (description?.length ?? 0) > DESCRIPTION_COLLAPSE_LENGTH;
  const metaDots: string[] = [];
  if (seriesName) {
    metaDots.push(`${seriesName}${seriesPosition != null ? ` #${seriesPosition}` : ''}`);
  }
  if (duration) metaDots.push(duration);
  if (publisher) metaDots.push(publisher);

  return (
    <div className="space-y-8">
      {/* Hero section with blurred backdrop */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-8 overflow-hidden">
        {/* Blurred backdrop */}
        {coverUrl && (
          <div className="absolute inset-0 -z-10">
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover blur-3xl opacity-20 scale-110"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
          </div>
        )}

        {/* Back link */}
        <button
          onClick={() => navigate('/library')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 focus-ring rounded-lg px-1 -ml-1 animate-fade-in-up"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Library
        </button>

        {/* Content */}
        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
          {/* Cover */}
          <div className="shrink-0 mx-auto sm:mx-0 animate-fade-in-up stagger-1">
            <div className="relative w-48 sm:w-56 lg:w-72 aspect-square rounded-2xl overflow-hidden shadow-card-hover ring-1 ring-black/10 group">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={`Cover of ${title}`}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-muted">
                  <BookOpenIcon className="w-16 h-16 text-muted-foreground/30" />
                </div>
              )}
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-2xl" />
            </div>
          </div>

          {/* Metadata */}
          <div className="flex-1 min-w-0 text-center sm:text-left">
            <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight animate-fade-in-up stagger-2">
              {title}
            </h1>

            {subtitle && (
              <p className="text-muted-foreground italic mt-1 text-lg animate-fade-in-up stagger-2">
                {subtitle}
              </p>
            )}

            {/* Author */}
            {authorName && (
              <div className="mt-3 animate-fade-in-up stagger-3">
                <span className="text-muted-foreground text-sm">by </span>
                {libraryBook.author?.asin ? (
                  <Link
                    to={`/authors/${libraryBook.author.asin}`}
                    className="text-primary hover:underline font-medium"
                  >
                    {authorName}
                  </Link>
                ) : (
                  <span className="font-medium">{authorName}</span>
                )}
              </div>
            )}

            {/* Narrators */}
            {narratorNames && (
              <p className="text-muted-foreground text-sm mt-1 animate-fade-in-up stagger-3">
                Narrated by {narratorNames}
              </p>
            )}

            {/* Meta dots: series · duration · publisher */}
            {metaDots.length > 0 && (
              <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">
                {metaDots.join(' \u00B7 ')}
              </p>
            )}

            {/* Status + Actions */}
            <div className="flex flex-wrap items-center gap-3 mt-6 justify-center sm:justify-start animate-fade-in-up stagger-4">
              <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium glass-card`}>
                <span className={`w-2 h-2 rounded-full ${status.dotClass}`} />
                {status.label}
              </span>
              <button
                onClick={() => setSearchModalOpen(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium glass-card hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
              >
                <SearchIcon className="w-4 h-4" />
                Search Releases
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      {description && (
        <div className="animate-fade-in-up stagger-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            About This Book
          </h2>
          <div className="glass-card rounded-2xl p-6">
            <div
              className={`prose prose-sm dark:prose-invert max-w-none ${!descriptionExpanded && descriptionLong ? 'line-clamp-4' : ''}`}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(description) }}
            />
            {descriptionLong && (
              <button
                onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                className="text-primary text-sm font-medium hover:underline mt-2 focus-ring rounded"
              >
                {descriptionExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Audio quality info */}
      <AudioInfo book={libraryBook} />

      {/* Genre chips */}
      {genres && genres.length > 0 && (
        <div className="animate-fade-in-up stagger-6">
          <div className="flex flex-wrap gap-2">
            {genres.map((genre) => (
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

      {/* Search Releases Modal */}
      <SearchReleasesModal
        isOpen={searchModalOpen}
        book={libraryBook}
        onClose={() => setSearchModalOpen(false)}
      />
    </div>
  );
}
