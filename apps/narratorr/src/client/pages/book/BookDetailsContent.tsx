import { AudioInfo } from '@/components/AudioInfo';
import { type BookWithAuthor } from '@/lib/api';
import { BookDescription } from './BookDescription.js';
import { FileList } from './FileList.js';

interface MergedData {
  description?: string;
  genres?: string[];
}

export function BookDetailsContent({ libraryBook, merged }: {
  libraryBook: BookWithAuthor;
  merged: MergedData;
}) {
  const hasDescription = !!merged.description;
  const hasGenres = merged.genres && merged.genres.length > 0;
  const hasFiles = !!libraryBook.path;
  const hasSidebar = libraryBook.audioCodec || hasGenres || hasFiles;

  if (!hasDescription && !hasSidebar) return null;

  return (
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
  );
}
