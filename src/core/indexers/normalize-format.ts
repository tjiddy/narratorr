/**
 * An indexer's container string → `SearchResult.format`. Blank/absent stays undefined (unknown,
 * not mp3). One fold for every adapter, so the same container renders one badge whatever the source.
 */
export function normalizeFormat(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}
