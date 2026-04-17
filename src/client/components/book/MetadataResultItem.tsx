import type { ReactNode } from 'react';
import type { BookMetadata, BookIdentifier, BookWithAuthor } from '@/lib/api';
import { resolveUrl } from '@/lib/url-utils';
import { isBookInLibrary } from '@/lib/helpers';
import { HeadphonesIcon, CheckCircleIcon } from '@/components/icons';

export interface MetadataResultItemProps {
  meta: BookMetadata;
  onSelect: (meta: BookMetadata) => void;
  showNarrators?: boolean;
  showSeries?: boolean;
  showDuration?: boolean;
  showLibraryBadge?: boolean;
  libraryBooks?: (BookIdentifier | BookWithAuthor)[];
  placeholderIcon?: ReactNode;
  coverSize?: 'sm' | 'md';
  dataTestId?: string;
}

export function MetadataResultItem({
  meta,
  onSelect,
  showNarrators = true,
  showSeries = false,
  showDuration = false,
  showLibraryBadge = false,
  libraryBooks,
  placeholderIcon,
  coverSize = 'sm',
  dataTestId,
}: MetadataResultItemProps) {
  const coverClasses = coverSize === 'md' ? 'w-9 h-12 rounded-md' : 'w-8 h-8 rounded';

  return (
    <button
      type="button"
      onClick={() => onSelect(meta)}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left rounded-xl hover:bg-muted/40 transition-colors group"
      data-testid={dataTestId}
    >
      <div className={`${coverClasses} shrink-0 overflow-hidden bg-muted/30 relative`}>
        {meta.coverUrl ? (
          <img src={resolveUrl(meta.coverUrl)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {placeholderIcon}
          </div>
        )}
        {coverSize === 'md' && (
          <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{meta.title}</p>
        <p className="text-xs text-muted-foreground/60 truncate">
          {meta.authors?.map(a => a.name).join(', ')}
        </p>
        {showNarrators && meta.narrators && meta.narrators.length > 0 && (
          <p className="text-[10px] text-muted-foreground/40 truncate flex items-center gap-1">
            <HeadphonesIcon className="w-2.5 h-2.5 shrink-0" />
            {meta.narrators.join(', ')}
          </p>
        )}
        {showSeries && meta.series && meta.series.length > 0 && (
          <p className="text-[10px] text-muted-foreground/40 truncate">
            {meta.series[0].name}{meta.series[0].position != null ? ` #${meta.series[0].position}` : ''}
          </p>
        )}
        {showDuration && meta.duration != null && meta.duration > 0 && (
          <p className="text-[10px] text-muted-foreground/40">
            {Math.floor(meta.duration / 60)}h {meta.duration % 60}m
          </p>
        )}
      </div>
      {showLibraryBadge && isBookInLibrary(meta, libraryBooks) && (
        <CheckCircleIcon className="w-3.5 h-3.5 shrink-0 text-emerald-400/70" />
      )}
    </button>
  );
}
