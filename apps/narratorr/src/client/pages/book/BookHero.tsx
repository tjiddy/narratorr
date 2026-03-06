import { Link } from 'react-router-dom';
import { ArrowLeftIcon, SearchIcon, BookOpenIcon, PencilIcon, RefreshIcon, TagIcon } from '@/components/icons';

interface BookHeroProps {
  title: string;
  subtitle?: string;
  authorName?: string;
  authorAsin?: string | null;
  narratorNames?: string;
  coverUrl?: string;
  metaDots: string[];
  statusLabel: string;
  statusDotClass: string;
  hasPath: boolean;
  onBackClick: () => void;
  onSearchClick: () => void;
  onEditClick: () => void;
  onRenameClick: () => void;
  isRenaming: boolean;
  onRetagClick: () => void;
  isRetagging: boolean;
  retagDisabled: boolean;
  retagTooltip?: string;
}

// eslint-disable-next-line complexity -- flat JSX conditionals for optional props, no branching logic
export function BookHero({
  title, subtitle, authorName, authorAsin, narratorNames,
  coverUrl, metaDots, statusLabel, statusDotClass,
  hasPath, onBackClick, onSearchClick, onEditClick, onRenameClick, isRenaming,
  onRetagClick, isRetagging, retagDisabled, retagTooltip,
}: BookHeroProps) {
  return (
    <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-6 overflow-hidden">
      {coverUrl && (
        <div className="absolute inset-0 -z-10">
          <img src={coverUrl} alt="" aria-hidden="true" className="w-full h-full object-cover blur-3xl opacity-20 scale-110" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
        </div>
      )}

      <button
        onClick={onBackClick}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 focus-ring rounded-lg px-1 -ml-1 animate-fade-in-up"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Library
      </button>

      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
        <div className="shrink-0 mx-auto sm:mx-0 animate-fade-in-up stagger-1">
          <div className="relative w-44 sm:w-48 lg:w-56 aspect-square rounded-2xl overflow-hidden shadow-card-hover ring-1 ring-white/[0.08] group">
            {coverUrl ? (
              <img src={coverUrl} alt={`Cover of ${title}`} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-muted">
                <BookOpenIcon className="w-16 h-16 text-muted-foreground/30" />
              </div>
            )}
            <div className="absolute inset-0 ring-1 ring-inset ring-white/[0.08] rounded-2xl" />
          </div>
        </div>

        <div className="flex-1 min-w-0 text-center sm:text-left">
          <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight animate-fade-in-up stagger-2">
            {title}
          </h1>

          {subtitle && (
            <p className="text-muted-foreground italic mt-1 text-lg animate-fade-in-up stagger-2">{subtitle}</p>
          )}

          {authorName && (
            <div className="mt-3 animate-fade-in-up stagger-3">
              <span className="text-muted-foreground text-sm">by </span>
              {authorAsin ? (
                <Link to={`/authors/${authorAsin}`} className="text-primary hover:underline font-medium">{authorName}</Link>
              ) : (
                <span className="font-medium">{authorName}</span>
              )}
            </div>
          )}

          {narratorNames && (
            <p className="text-muted-foreground text-sm mt-1 animate-fade-in-up stagger-3">Narrated by {narratorNames}</p>
          )}

          {metaDots.length > 0 && (
            <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">{metaDots.join(' \u00B7 ')}</p>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-6 justify-center sm:justify-start animate-fade-in-up stagger-4">
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium glass-card">
              <span className={`w-2 h-2 rounded-full ${statusDotClass}`} />
              {statusLabel}
            </span>
            <button
              onClick={onSearchClick}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium glass-card hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
            >
              <SearchIcon className="w-4 h-4" />
              Search Releases
            </button>
            <button
              onClick={onEditClick}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground glass-card hover:border-primary/30 transition-all duration-200 focus-ring"
            >
              <PencilIcon className="w-3.5 h-3.5" />
              Edit
            </button>
            {hasPath && (
              <button
                onClick={onRenameClick}
                disabled={isRenaming}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground glass-card hover:border-primary/30 transition-all duration-200 focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshIcon className={`w-3.5 h-3.5 ${isRenaming ? 'animate-spin' : ''}`} />
                {isRenaming ? 'Renaming...' : 'Rename'}
              </button>
            )}
            {hasPath && (
              <button
                onClick={onRetagClick}
                disabled={isRetagging || retagDisabled}
                title={retagDisabled ? retagTooltip : undefined}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground glass-card hover:border-primary/30 transition-all duration-200 focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <TagIcon className={`w-3.5 h-3.5 ${isRetagging ? 'animate-spin' : ''}`} />
                {isRetagging ? 'Re-tagging...' : 'Re-tag files'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
