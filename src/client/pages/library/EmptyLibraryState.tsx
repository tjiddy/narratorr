import { Link } from 'react-router-dom';
import {
  LibraryIcon as BookShelfIcon,
  SearchIcon,
  ArrowRightIcon,
  FolderIcon,
  SettingsIcon,
} from '@/components/icons';
import { EmptyState } from '@/components/EmptyState.js';

interface EmptyLibraryStateProps {
  hasLibraryPath?: boolean;
}

export function EmptyLibraryState({ hasLibraryPath }: EmptyLibraryStateProps) {
  return (
    <EmptyState
      icon={BookShelfIcon}
      title="Your library is empty"
      subtitle="Start building your audiobook collection by discovering and adding books"
    >
      {hasLibraryPath ? (
        <Link
          to="/library-import"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
        >
          <FolderIcon className="w-4 h-4" />
          Import Existing Library
          <ArrowRightIcon className="w-4 h-4" />
        </Link>
      ) : (
        <Link
          to="/settings"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
        >
          <SettingsIcon className="w-4 h-4" />
          Go to Settings
          <ArrowRightIcon className="w-4 h-4" />
        </Link>
      )}
      <Link
        to="/import"
        className="inline-flex items-center gap-2 px-6 py-3 glass-card font-medium rounded-xl hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
      >
        <FolderIcon className="w-4 h-4" />
        Manual Import
      </Link>
      <Link
        to="/search"
        className="inline-flex items-center gap-2 px-6 py-3 glass-card font-medium rounded-xl hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
      >
        <SearchIcon className="w-4 h-4" />
        Add a Book
      </Link>
    </EmptyState>
  );
}
