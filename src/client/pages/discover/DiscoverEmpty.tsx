import { Link } from 'react-router-dom';
import { LibraryIcon, CompassIcon, ArrowRightIcon, SearchIcon } from '@/components/icons';
import { EmptyState } from '@/components/EmptyState.js';

export function DiscoverEmpty({
  variant,
}: {
  variant: 'no-library' | 'no-suggestions';
}) {
  return (
    <EmptyState
      icon={variant === 'no-library' ? LibraryIcon : CompassIcon}
      title={variant === 'no-library' ? 'No books yet' : 'All caught up'}
      subtitle={
        variant === 'no-library'
          ? "Add some books to your library and we'll start finding recommendations"
          : 'No new suggestions right now — check back later or hit Refresh'
      }
      data-testid="discover-empty"
    >
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
    </EmptyState>
  );
}
