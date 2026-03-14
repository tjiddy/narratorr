import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality } from '../../core/utils/index.js';
import type { SearchResult } from '../../core/index.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadService } from './download.service.js';

/** Build a search query string from a book's title and author. */
export function buildSearchQuery(book: { title: string; author?: { name: string } | null }): string {
  return [book.title, book.author?.name].filter(Boolean).join(' ');
}

/**
 * Canonical ranking comparator: matchScore gate → MB/hr → protocol preference → seeders.
 */
// eslint-disable-next-line complexity -- 4-tier sort with null coalescing inflates counted branches
function canonicalCompare(
  a: SearchResult,
  b: SearchResult,
  bookDuration: number | undefined,
  durationUnknown: boolean,
  protocolPreference: string,
): number {
  const scoreA = a.matchScore ?? 0;
  const scoreB = b.matchScore ?? 0;
  const scoreDiff = scoreB - scoreA;

  if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

  if (!durationUnknown) {
    const qualA = (a.size && a.size > 0) ? calculateQuality(a.size, bookDuration!) : null;
    const qualB = (b.size && b.size > 0) ? calculateQuality(b.size, bookDuration!) : null;
    const mbhrA = qualA?.mbPerHour ?? -1;
    const mbhrB = qualB?.mbPerHour ?? -1;
    if (mbhrA !== mbhrB) return mbhrB - mbhrA;
  }

  if (protocolPreference !== 'none') {
    const prefA = a.protocol === protocolPreference ? 1 : 0;
    const prefB = b.protocol === protocolPreference ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;
  }

  return (b.seeders ?? 0) - (a.seeders ?? 0);
}

/** Parse a comma-separated word list into trimmed, non-empty lowercase entries. */
export function parseWordList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * Apply quality filtering and canonical ranking to search results.
 * Filters by word lists, MB/hr grab floor, and min seeders, then sorts by
 * canonical order: matchScore gate → MB/hr → protocol preference → seeders.
 */
export function filterAndRankResults(
  results: SearchResult[],
  bookDuration: number | undefined,
  grabFloor: number,
  minSeeders: number,
  protocolPreference: string,
  rejectWords?: string,
  requiredWords?: string,
): { results: SearchResult[]; durationUnknown: boolean } {
  const durationUnknown = !bookDuration || bookDuration <= 0;

  let filtered = results;

  // Apply reject word filtering (before ranking)
  const rejectList = parseWordList(rejectWords);
  if (rejectList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.rawTitle ?? r.title).toLowerCase();
      return !rejectList.some((word) => sourceTitle.includes(word));
    });
  }

  // Apply required word filtering (before ranking)
  const requiredList = parseWordList(requiredWords);
  if (requiredList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.rawTitle ?? r.title).toLowerCase();
      return requiredList.some((word) => sourceTitle.includes(word));
    });
  }

  // Apply min seeders filter (torrent only)
  if (minSeeders > 0) {
    filtered = filtered.filter((r) => {
      if (r.protocol !== 'torrent') return true;
      return (r.seeders ?? 0) >= minSeeders;
    });
  }

  // Apply grab floor filter (only when duration is known)
  if (!durationUnknown && grabFloor > 0) {
    filtered = filtered.filter((r) => {
      if (!r.size || r.size <= 0) return true; // can't calculate, pass through
      const quality = calculateQuality(r.size, bookDuration!);
      if (!quality) return true; // can't calculate, pass through
      return quality.mbPerHour >= grabFloor;
    });
  }

  // Canonical ranking
  filtered.sort((a, b) => canonicalCompare(a, b, bookDuration, durationUnknown, protocolPreference));

  return { results: filtered, durationUnknown };
}

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string }
  | { result: 'grab_error'; error: unknown };

/**
 * Search indexers for a single book and auto-grab the best result.
 * Core search-and-grab logic shared by all callers (jobs, routes).
 */
export async function searchAndGrabForBook(
  book: { id: number; title: string; duration?: number | null; author?: { name: string } | null },
  indexerService: IndexerService,
  downloadService: DownloadService,
  qualitySettings: { grabFloor: number; minSeeders: number; protocolPreference: string; rejectWords?: string; requiredWords?: string },
  log: FastifyBaseLogger,
): Promise<SingleBookSearchResult> {
  const query = buildSearchQuery(book);
  const rawResults = await indexerService.searchAll(query, {
    title: book.title,
    author: book.author?.name,
  });

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const { results } = filterAndRankResults(
    rawResults,
    book.duration ?? undefined,
    qualitySettings.grabFloor,
    qualitySettings.minSeeders,
    qualitySettings.protocolPreference,
    qualitySettings.rejectWords,
    qualitySettings.requiredWords,
  );

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    return { result: 'no_results' };
  }

  try {
    await downloadService.grab({
      downloadUrl: best.downloadUrl!,
      title: best.title,
      protocol: best.protocol,
      bookId: book.id,
      size: best.size,
      seeders: best.seeders,
    });
    log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
    return { result: 'grabbed', title: best.title };
  } catch (grabError) {
    const message = grabError instanceof Error ? grabError.message : String(grabError);
    if (message.includes('already has an active download')) {
      log.debug({ bookId: book.id, title: book.title }, 'Skipping grab — book already has active download');
      return { result: 'skipped', reason: 'already_has_active_download' };
    }
    return { result: 'grab_error', error: grabError };
  }
}
