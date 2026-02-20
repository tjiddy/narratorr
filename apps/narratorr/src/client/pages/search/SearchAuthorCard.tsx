import { CoverImage } from '@/components/CoverImage';
import { type AuthorMetadata } from '@/lib/api';
import { toast } from 'sonner';
import { UsersIcon, ArrowRightIcon } from '@/components/icons';

export function SearchAuthorCard({ author, index }: { author: AuthorMetadata; index: number }) {
  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-center gap-4">
        {/* Author Image */}
        <div className="shrink-0">
          <CoverImage
            src={author.imageUrl}
            alt={author.name}
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-full"
            fallback={<UsersIcon className="w-6 h-6 text-muted-foreground" />}
          />
        </div>

        {/* Author Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-lg font-semibold group-hover:text-primary transition-colors truncate">
            {author.name}
          </h3>
          {author.genres && author.genres.length > 0 && (
            <p className="text-sm text-muted-foreground truncate">
              {author.genres.join(', ')}
            </p>
          )}
        </div>

        {/* View Button */}
        {author.asin && (
          <button
            onClick={() => toast.info('Author pages coming soon!')}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors focus-ring"
          >
            View
            <ArrowRightIcon className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
