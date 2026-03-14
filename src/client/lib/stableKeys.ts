import type { BookMetadata, AuthorMetadata, SearchResult } from '@/lib/api';

export interface ImportListItemKey {
  title: string;
  author?: string;
  asin?: string;
  isbn?: string;
}

/**
 * Generate a stable, order-independent React key for a BookMetadata result.
 * Includes all available stable fields to minimize collisions.
 */
export function bookMetadataKey(book: BookMetadata): string {
  return `${book.asin ?? ''}-${book.providerId ?? ''}-${book.title}-${book.authors[0]?.name ?? ''}`;
}

/**
 * Generate a stable, order-independent React key for an AuthorMetadata result.
 * Uses asin when available, otherwise name + imageUrl.
 */
export function authorMetadataKey(author: AuthorMetadata): string {
  if (author.asin) return author.asin;
  return `${author.name}-${author.imageUrl ?? ''}`;
}

/**
 * Generate a stable, order-independent React key for a SearchResult.
 * Prefers infoHash, then downloadUrl, then composite fields.
 */
export function searchResultKey(result: SearchResult): string {
  if (result.infoHash) return result.infoHash;
  if (result.downloadUrl) return result.downloadUrl;
  return `${result.protocol}-${result.indexer}-${result.title}-${result.author ?? result.rawTitle ?? ''}-${result.detailsUrl ?? ''}`;
}

/**
 * Generate a stable, order-independent React key for an ImportListItem.
 * Uses asin or isbn when available, otherwise title + author composite.
 */
export function importListItemKey(item: ImportListItemKey): string {
  if (item.asin) return item.asin;
  if (item.isbn) return item.isbn;
  return `${item.title}-${item.author ?? ''}`;
}

/**
 * Given an array of base keys, appends `-N` suffixes only where duplicates
 * exist, so that unique identifiers remain stable and order-independent.
 */
export function deduplicateKeys(keys: string[]): string[] {
  const counts = new Map<string, number>();
  return keys.map((key) => {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return n === 0 ? key : `${key}-dup${n}`;
  });
}
