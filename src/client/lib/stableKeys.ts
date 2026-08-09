import type { BookMetadata, AuthorMetadata, SearchResult } from '@/lib/api';

export interface ImportListItemKey {
  title: string;
  author?: string;
  asin?: string;
  isbn?: string;
}

export function bookMetadataKey(book: BookMetadata): string {
  return `${book.asin ?? ''}-${book.providerId ?? ''}-${book.title}-${book.authors[0]?.name ?? ''}`;
}

export function authorMetadataKey(author: AuthorMetadata): string {
  if (author.asin) return author.asin;
  return `${author.name}-${author.imageUrl ?? ''}`;
}

export function searchResultKey(result: SearchResult): string {
  if (result.infoHash) return result.infoHash;
  if (result.downloadUrl) return result.downloadUrl;
  return `${result.protocol}-${result.indexer}-${result.title}-${result.author ?? result.rawTitle ?? ''}-${result.detailsUrl ?? ''}`;
}

export function importListItemKey(item: ImportListItemKey): string {
  if (item.asin) return item.asin;
  if (item.isbn) return item.isbn;
  return `${item.title}-${item.author ?? ''}`;
}

/** Leaves unique keys unchanged and suffixes later duplicates. */
export function deduplicateKeys(keys: string[]): string[] {
  const counts = new Map<string, number>();
  return keys.map((key) => {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return n === 0 ? key : `${key}-dup${n}`;
  });
}
