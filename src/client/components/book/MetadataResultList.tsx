import type { ReactNode } from 'react';
import type { BookMetadata, BookIdentifier, BookWithAuthor } from '@/lib/api';
import { MetadataResultItem } from './MetadataResultItem';

export interface MetadataResultListProps {
  results: BookMetadata[];
  limit: number;
  maxHeight: string;
  onSelect: (meta: BookMetadata) => void;
  showNarrators?: boolean | undefined;
  showSeries?: boolean | undefined;
  showDuration?: boolean | undefined;
  showLibraryBadge?: boolean | undefined;
  libraryBooks?: (BookIdentifier | BookWithAuthor)[] | undefined;
  placeholderIcon?: ReactNode;
  coverSize?: 'sm' | 'md' | undefined;
  itemClassName?: string | undefined;
  dataTestId?: string | undefined;
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
