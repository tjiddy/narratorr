import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality } from '../../core/utils/index.js';
import type { SearchResult } from '../../core/index.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download.service.js';

/** Build a search query string from a book's title and primary author. */
export function buildSearchQuery(book: { title: string; authors?: Array<{ name: string }> | null }): string {
  return [book.title, book.authors?.[0]?.name].filter(Boolean).join(' ');
}

/**
 * Canonical ranking comparator:
 * matchScore gate → MB/hr → protocol preference → language → grabs → seeders.
 */
// eslint-disable-next-line complexity -- 6-tier sort with null coalescing inflates counted branches
function canonicalCompare(
  a: SearchResult,
  b: SearchResult,
  bookDuration: number | undefined,
  durationUnknown: boolean,
  protocolPreference: string,
  preferredLanguage: string,
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

  // Language tier: mismatch ranks below match/unknown (absence ≠ mismatch)
  if (preferredLanguage) {
    const aMatch = !a.language || a.language === preferredLanguage ? 1 : 0;
    const bMatch = !b.language || b.language === preferredLanguage ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
  }

  // Grabs tier: log-scale normalization
  const grabsA = Math.log10((a.grabs ?? 0) + 1);
  const grabsB = Math.log10((b.grabs ?? 0) + 1);
  if (grabsA !== grabsB) return grabsB - grabsA;

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
  preferredLanguage?: string,
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

  // Ebook-only format filter: exclude results that contain ebook keywords (AZW3, EPUB, PDF, MOBI)
  // but no audio keywords (M4B, MP3, FLAC, AAC, OGG). Mixed-format results are kept.
  // Use lookahead/lookbehind instead of \b because JS treats _ as a word char,
  // which would miss scene-style titles like "Dune_EPUB".
  const EBOOK_FORMAT_RE = /(?<![a-zA-Z\d])(azw3|epub|pdf|mobi)(?![a-zA-Z\d])/i;
  const AUDIO_FORMAT_RE = /(?<![a-zA-Z\d])(m4b|mp3|flac|aac|ogg)(?![a-zA-Z\d])/i;
  filtered = filtered.filter((r) => {
    const sourceTitle = r.rawTitle ?? r.title;
    if (!EBOOK_FORMAT_RE.test(sourceTitle)) return true;
    return AUDIO_FORMAT_RE.test(sourceTitle);
  });

  // Apply min seeders filter (torrent only)
  if (minSeeders > 0) {
    filtered = filtered.filter((r) => {
      if (r.protocol !== 'torrent') return true;
      if (r.seeders === undefined || r.seeders === null) return true; // Unknown ≠ zero
      return r.seeders >= minSeeders;
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
  filtered.sort((a, b) => canonicalCompare(a, b, bookDuration, durationUnknown, protocolPreference, preferredLanguage ?? ''));

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
  book: { id: number; title: string; duration?: number | null; authors?: Array<{ name: string }> | null },
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  qualitySettings: { grabFloor: number; minSeeders: number; protocolPreference: string; rejectWords?: string; requiredWords?: string; preferredLanguage?: string },
  log: FastifyBaseLogger,
): Promise<SingleBookSearchResult> {
  const query = buildSearchQuery(book);
  const rawResults = await indexerService.searchAll(query, {
    title: book.title,
    author: book.authors?.[0]?.name,
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
    qualitySettings.preferredLanguage,
  );

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    return { result: 'no_results' };
  }

  try {
    await downloadOrchestrator.grab({
      downloadUrl: best.downloadUrl!,
      title: best.title,
      protocol: best.protocol,
      bookId: book.id,
      size: best.size,
      seeders: best.seeders,
      guid: best.guid,
    });
    log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
    return { result: 'grabbed', title: best.title };
  } catch (grabError: unknown) {
    if (grabError instanceof DuplicateDownloadError) {
      log.debug({ bookId: book.id, title: book.title }, 'Skipping grab — book already has active download');
      return { result: 'skipped', reason: 'already_has_active_download' };
    }
    return { result: 'grab_error', error: grabError };
  }
}
