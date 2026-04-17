import type { ReactNode } from 'react';
import type { BookMetadata, BookIdentifier, BookWithAuthor } from '@/lib/api';
import { MetadataResultItem } from './MetadataResultItem';

export interface MetadataResultListProps {
  results: BookMetadata[];
  limit: number;
  maxHeight: string;
  onSelect: (meta: BookMetadata) => void;
  showNarrators?: boolean;
  showSeries?: boolean;
  showDuration?: boolean;
  showLibraryBadge?: boolean;
  libraryBooks?: (BookIdentifier | BookWithAuthor)[];
  placeholderIcon?: ReactNode;
  coverSize?: 'sm' | 'md';
  itemClassName?: string;
  dataTestId?: string;
}

export function MetadataResultList({
  results,
  limit,
  maxHeight,
  onSelect,
  showNarrators,
  showSeries,
  showDuration,
  showLibraryBadge,
  libraryBooks,
  placeholderIcon,
  coverSize,
  itemClassName,
  dataTestId,
}: MetadataResultListProps) {
  if (results.length === 0) return null;

  return (
    <div className={`${maxHeight} overflow-y-auto space-y-1 -mx-1 px-1`}>
      {results.slice(0, limit).map((meta, i) => (
        <MetadataResultItem
          key={meta.asin || meta.providerId || i}
          meta={meta}
          onSelect={onSelect}
          showNarrators={showNarrators}
          showSeries={showSeries}
          showDuration={showDuration}
          showLibraryBadge={showLibraryBadge}
          libraryBooks={libraryBooks}
          placeholderIcon={placeholderIcon}
          coverSize={coverSize}
          className={itemClassName}
          dataTestId={dataTestId ? `${dataTestId}-${i}` : undefined}
        />
      ))}
    </div>
  );
}
