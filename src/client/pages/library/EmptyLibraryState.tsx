import { Link } from 'react-router-dom';
import {
  LibraryIcon as BookShelfIcon,
  SearchIcon,
  ArrowRightIcon,
  FolderIcon,
} from '@/components/icons';

export function EmptyLibraryState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <BookShelfIcon className="w-16 h-16 text-primary" />
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold text-center mb-3">
        Your library is empty
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        Start building your audiobook collection by discovering and adding books
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/import"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
        >
          <FolderIcon className="w-4 h-4" />
          Manual Import
          <ArrowRightIcon className="w-4 h-4" />
        </Link>
        <Link
          to="/search"
          className="inline-flex items-center gap-2 px-6 py-3 glass-card font-medium rounded-xl hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
        >
          <SearchIcon className="w-4 h-4" />
          Add a Book
        </Link>
      </div>
    </div>
  );
}
