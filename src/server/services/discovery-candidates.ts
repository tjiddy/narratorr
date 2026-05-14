import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '../../core/index.js';
import { diceCoefficient } from '../../core/utils/similarity.js';
import type { SuggestionReason } from '../../shared/schemas/discovery.js';
import type { MetadataService } from './metadata.service.js';
import type { WeightMultipliers } from './discovery-weights.js';
import { DEFAULT_MULTIPLIERS } from './discovery-weights.js';
import type { LibrarySignals } from './discovery.service.js';
import { serializeError } from '../utils/serialize-error.js';


const FP_TOLERANCE = 1e-9;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < FP_TOLERANCE;
}

function includesNearly(arr: number[], value: number): boolean {
  return arr.some(v => nearlyEqual(v, value));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  asin: string;
  title: string;
  authorName: string;
  authorAsin?: string | undefined;
  narratorName?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  language?: string | undefined;
  genres?: string[] | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  reason: SuggestionReason;
  reasonContext: string;
  score: number;
}

export interface CandidateContext {
  languages: string[];
  existingAsins: Set<string>;
  existingTitleAuthors: Array<{ title: string; author: string }>;
  dismissedAsins: Set<string>;
  maxPerAuthor: number;
  signals: LibrarySignals;
  warnings: string[];
  queriedAuthor?: string;
  multipliers: WeightMultipliers;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIGNAL_WEIGHTS = { author: 40, series: 50, genre: 25, narrator: 20, diversity: 15 } as const;
const MAX_STRENGTH_BOOKS = 5;
const DIVERSITY_TARGET = 2;

/** Broad Audible genre categories for diversity candidate sourcing. */
export const DIVERSITY_GENRES = [
  'Mystery', 'Thriller', 'Science Fiction', 'Fantasy', 'Romance',
  'Horror', 'Biography', 'History', 'Business', 'Self-Help',
  'True Crime', 'Comedy', 'Health & Wellness', 'Philosophy', 'Travel',
] as const;

// ---------------------------------------------------------------------------
// Per-signal candidate queries
// ---------------------------------------------------------------------------

interface QueryDeps {
  metadataService: MetadataService;
  log: FastifyBaseLogger;
}

export async function queryAuthorCandidates(deps: QueryDeps, signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
  const top = [...signals.authorAffinity.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  for (const [, { name, strength }] of top) {
    try {
      const { books: results, warnings } = await deps.metadataService.searchBooksForDiscovery(name, { maxResults: 25 });
      ctx.warnings.push(...warnings);
      const cap = new Map<string, number>();
      ctx.queriedAuthor = name;
      filterAndScore(results, 'author', () => `New from ${name} — you have ${signals.authorAffinity.get(name)?.count ?? 0} of their books`, strength, ctx, map, cap);
      delete ctx.queriedAuthor;
    } catch (error: unknown) { deps.log.warn({ error: serializeError(error) }, `Discovery: author query failed for ${name}`); }
  }
}

export async function querySeriesCandidates(deps: QueryDeps, signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
  for (const gap of signals.seriesGaps) {
    try {
      const { books: results, warnings } = await deps.metadataService.searchBooksForDiscovery(gap.seriesName, { title: gap.seriesName, author: gap.authorName });
      ctx.warnings.push(...warnings);
      const filtered = results.filter(b => {
        const s = b.series?.find(s => s.name?.toLowerCase() === gap.seriesName.toLowerCase());
        return s?.position != null && (includesNearly(gap.missingPositions, s.position) || nearlyEqual(s.position, gap.nextPosition));
      });
      filterAndScore(filtered, 'series', (book) => {
        const pos = book.series?.find(s => s.name?.toLowerCase() === gap.seriesName.toLowerCase())?.position;
        return `Next in ${gap.seriesName} — you have books 1-${gap.maxOwned}${pos != null && nearlyEqual(pos, gap.nextPosition) ? '' : ` (position ${pos})`}`;
      }, 1.0, ctx, map);
    } catch (error: unknown) { deps.log.warn({ error: serializeError(error) }, `Discovery: series query failed for ${gap.seriesName}`); }
  }
}

export async function queryGenreCandidates(deps: QueryDeps, signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
  const topGenres = [...signals.genreDistribution.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const libraryAuthors = new Set([...signals.authorAffinity.keys()]);
  for (const [genre] of topGenres) {
    try {
      const { books: results, warnings } = await deps.metadataService.searchBooksForDiscovery(genre);
      ctx.warnings.push(...warnings);
      const filtered = results.filter(b => !b.authors?.[0]?.name || !libraryAuthors.has(b.authors[0].name));
      filterAndScore(filtered, 'genre', () => `Popular in ${genre} — your most-read genre`, 0.5, ctx, map);
    } catch (error: unknown) { deps.log.warn({ error: serializeError(error) }, `Discovery: genre query failed for ${genre}`); }
  }
}

export async function queryNarratorCandidates(deps: QueryDeps, signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
  for (const [name, count] of signals.narratorAffinity) {
    try {
      const { books: results, warnings } = await deps.metadataService.searchBooksForDiscovery(name);
      ctx.warnings.push(...warnings);
      filterAndScore(results, 'narrator', () => `Narrated by ${name} — you've enjoyed ${count} of their performances`, Math.min(count / MAX_STRENGTH_BOOKS, 1.0), ctx, map);
    } catch (error: unknown) { deps.log.warn({ error: serializeError(error) }, `Discovery: narrator query failed for ${name}`); }
  }
}

export async function queryDiversityCandidates(deps: QueryDeps, signals: LibrarySignals, ctx: CandidateContext): Promise<ScoredCandidate[]> {
  const libraryGenresLower = new Set([...signals.genreDistribution.keys()].map(g => g.toLowerCase()));
  const missingGenres = DIVERSITY_GENRES.filter(g => !libraryGenresLower.has(g.toLowerCase()));
  if (missingGenres.length === 0) return [];

  const shuffled = [...missingGenres].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, DIVERSITY_TARGET);
  const candidates: ScoredCandidate[] = [];
  const seenAsins = new Set<string>();
  const cap = new Map<string, number>();

  for (const genre of picks) {
    try {
      const { books: results, warnings } = await deps.metadataService.searchBooksForDiscovery(genre);
      ctx.warnings.push(...warnings);
      const eligible = results.filter(b => isEligibleCandidate(b, ctx, cap));
      for (const book of eligible) {
        if (seenAsins.has(book.asin!)) continue;
        const score = scoreCandidate(book, 'diversity', 0.3, ctx.signals, ctx.multipliers);
        candidates.push(toScoredCandidate(book, 'diversity', `Something different — explore ${genre}`, score));
        seenAsins.add(book.asin!);
        break;
      }
    } catch (error: unknown) { deps.log.warn({ error: serializeError(error) }, `Discovery: diversity query failed for ${genre}`); }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Filtering + scoring
// ---------------------------------------------------------------------------

export function filterAndScore(
  results: BookMetadata[], reason: SuggestionReason, contextFn: (b: BookMetadata) => string,
  strength: number, ctx: CandidateContext, map: Map<string, ScoredCandidate>, authorCap?: Map<string, number>,
) {
  const eligible = results.filter(b => isEligibleCandidate(b, ctx, authorCap));
  for (const book of eligible) {
    const score = scoreCandidate(book, reason, strength, ctx.signals, ctx.multipliers);
    const existing = map.get(book.asin!);
    if (!existing || score > existing.score) {
      map.set(book.asin!, toScoredCandidate(book, reason, contextFn(book), score));
    }
  }
}

export function isEligibleCandidate(book: BookMetadata, ctx: CandidateContext, authorCap?: Map<string, number>): boolean {
  if (!book.asin) return false;
  if (ctx.existingAsins.has(book.asin) || ctx.dismissedAsins.has(book.asin)) return false;
  if (ctx.languages.length > 0) {
    if (!book.language || !ctx.languages.some(l => l.toLowerCase() === book.language!.toLowerCase())) return false;
  } else if (!book.language) {
    return false;
  }
  const candidateAuthor = book.authors?.[0]?.name ?? '';
  if (isTitleAuthorDuplicate(book.title, candidateAuthor, ctx.existingTitleAuthors)) return false;
  if (!isAuthorMatchClose(candidateAuthor, ctx.queriedAuthor)) return false;
  return checkAuthorCap(candidateAuthor, authorCap, ctx.maxPerAuthor);
}

function isAuthorMatchClose(candidateAuthor: string, queriedAuthor?: string): boolean {
  if (!queriedAuthor || !candidateAuthor) return true;
  return diceCoefficient(candidateAuthor, queriedAuthor) >= 0.6;
}

function checkAuthorCap(candidateAuthor: string, authorCap?: Map<string, number>, maxPerAuthor?: number): boolean {
  if (!authorCap || maxPerAuthor == null) return true;
  const key = candidateAuthor || 'unknown';
  const cnt = authorCap.get(key) ?? 0;
  if (cnt >= maxPerAuthor) return false;
  authorCap.set(key, cnt + 1);
  return true;
}

function isTitleAuthorDuplicate(title: string, authorName: string, existing: Array<{ title: string; author: string }>): boolean {
  for (const e of existing) {
    const titleSim = diceCoefficient(title, e.title);
    const authorSim = authorName && e.author ? diceCoefficient(authorName, e.author) : 0;
    if (titleSim >= 0.8 && authorSim >= 0.7) return true;
  }
  return false;
}

export function toScoredCandidate(book: BookMetadata, reason: SuggestionReason, reasonContext: string, score: number): ScoredCandidate {
  // `seriesPrimary` is the canonical primary-series ref (Audnexus-derived, #1088).
  // Fall back to `series?.[0]` for books whose enrichment didn't populate it.
  const primary = book.seriesPrimary ?? book.series?.[0];
  return {
    asin: book.asin!, title: book.title, authorName: book.authors?.[0]?.name ?? 'Unknown',
    authorAsin: book.authors?.[0]?.asin,
    narratorName: book.narrators?.[0], coverUrl: book.coverUrl, duration: book.duration,
    publishedDate: book.publishedDate, language: book.language, genres: book.genres,
    seriesName: primary?.name, seriesPosition: primary?.position,
    reason, reasonContext, score,
  };
}

/**
 * Series-gap bonus against the canonical primary-series ref so a universe
 * entry in `series[0]` (e.g. Cosmere) doesn't shadow the real next-in-series
 * gap (Stormlight). (#1097)
 */
function seriesGapBonus(book: BookMetadata, signals: LibrarySignals): number {
  const primary = book.seriesPrimary ?? book.series?.[0];
  if (!primary?.name || primary.position == null) return 0;
  const gap = signals.seriesGaps.find(g => g.seriesName.toLowerCase() === primary.name!.toLowerCase());
  return gap && nearlyEqual(primary.position, gap.nextPosition) ? 20 : 0;
}

export function scoreCandidate(book: BookMetadata, reason: SuggestionReason, strength: number, signals: LibrarySignals, multipliers: WeightMultipliers = DEFAULT_MULTIPLIERS): number {
  let score = SIGNAL_WEIGHTS[reason] * (multipliers[reason] ?? 1) * strength;

  if (signals.durationStats && book.duration) {
    if (Math.abs(book.duration - signals.durationStats.median) <= signals.durationStats.stddev) score += 5;
  }
  if (book.publishedDate) {
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    if (new Date(book.publishedDate) >= twoYearsAgo) score += 10;
  }
  if (reason === 'series') score += seriesGapBonus(book, signals);

  return Math.min(Math.max(score, 0), 100);
}
