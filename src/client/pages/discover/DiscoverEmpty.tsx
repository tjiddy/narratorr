import { Link } from 'react-router-dom';
import { LibraryIcon, CompassIcon, ArrowRightIcon, SearchIcon } from '@/components/icons';

export function DiscoverEmpty({
  variant,
}: {
  variant: 'no-library' | 'no-suggestions';
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2" data-testid="discover-empty">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          {variant === 'no-library' ? (
            <LibraryIcon className="w-16 h-16 text-primary" />
          ) : (
            <CompassIcon className="w-16 h-16 text-primary" />
          )}
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold text-center mb-3">
        {variant === 'no-library' ? 'No books yet' : 'All caught up'}
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        {variant === 'no-library'
          ? 'Add some books to your library and we\'ll start finding recommendations'
          : 'No new suggestions right now — check back later or hit Refresh'}
      </p>
      {variant === 'no-library' && (
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/search"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
          >
            <SearchIcon className="w-4 h-4" />
            Find Books
            <ArrowRightIcon className="w-4 h-4" />
          </Link>
        </div>
      )}
    </div>
  );
}
