import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { suggestions, books, authors } from '../../db/schema.js';
import { REGION_LANGUAGES, type BookMetadata } from '../../core/index.js';
import { diceCoefficient } from '../../core/utils/similarity.js';
import type { MetadataService } from './metadata.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import { extractSignals } from './discovery-signals.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SuggestionRow = typeof suggestions.$inferSelect;

export type SuggestionReason = 'author' | 'series' | 'genre' | 'narrator';

export interface LibrarySignals {
  authorAffinity: Map<string, { count: number; strength: number; name: string }>;
  genreDistribution: Map<string, number>;
  seriesGaps: Array<{ seriesName: string; authorName: string; missingPositions: number[]; maxOwned: number }>;
  narratorAffinity: Map<string, number>;
  durationStats: { median: number; stddev: number } | null;
}

export interface ScoredCandidate {
  asin: string;
  title: string;
  authorName: string;
  narratorName?: string;
  coverUrl?: string;
  duration?: number;
  publishedDate?: string;
  language?: string;
  genres?: string[];
  seriesName?: string;
  seriesPosition?: number;
  reason: SuggestionReason;
  reasonContext: string;
  score: number;
}

const SIGNAL_WEIGHTS = { author: 40, series: 50, genre: 25, narrator: 20 } as const;
const MAX_STRENGTH_BOOKS = 5;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DiscoveryService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService: MetadataService,
    private bookService: BookService,
    private settingsService: SettingsService,
  ) {}

  async analyzeLibrary(): Promise<LibrarySignals> {
    const rows = await this.db
      .select({ book: books, author: authors })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(eq(books.status, 'imported'));
    return extractSignals(rows);
  }

  async generateCandidates(signals: LibrarySignals): Promise<ScoredCandidate[]> {
    const settings = await this.settingsService.get('discovery');
    const metadataSettings = await this.settingsService.get('metadata');
    const regionLang = REGION_LANGUAGES[metadataSettings.audibleRegion] ?? 'english';
    const warnings: string[] = [];

    const existingRows = await this.db.select({ asin: books.asin, title: books.title, authorName: authors.name }).from(books).leftJoin(authors, eq(books.authorId, authors.id));
    const existingAsins = new Set(existingRows.filter(b => b.asin).map(b => b.asin!));
    const existingTitleAuthors = existingRows.map(b => ({ title: b.title, author: b.authorName ?? '' }));
    const dismissedRows = await this.db.select({ asin: suggestions.asin }).from(suggestions).where(eq(suggestions.status, 'dismissed'));
    const dismissedAsins = new Set(dismissedRows.map(s => s.asin));

    const ctx = { regionLang, existingAsins, existingTitleAuthors, dismissedAsins, maxPerAuthor: settings.maxSuggestionsPerAuthor, signals, warnings, queriedAuthor: undefined as string | undefined };
    const map = new Map<string, ScoredCandidate>();

    await this.queryAuthorCandidates(signals, ctx, map);
    await this.querySeriesCandidates(signals, ctx, map);
    await this.queryGenreCandidates(signals, ctx, map);
    await this.queryNarratorCandidates(signals, ctx, map);

    for (const w of warnings) this.log.warn({ warning: w }, 'Discovery: metadata search warning');
    return [...map.values()];
  }

  async refreshSuggestions(): Promise<{ added: number; removed: number; warnings: string[] }> {
    const signals = await this.analyzeLibrary();
    const candidates = await this.generateCandidates(signals);
    const currentPending = await this.db.select({ id: suggestions.id, asin: suggestions.asin }).from(suggestions).where(eq(suggestions.status, 'pending'));
    const regeneratedAsins = new Set(candidates.map(c => c.asin));
    const now = new Date();

    let added = 0;
    for (const c of candidates) {
      const rows = await this.db.select().from(suggestions).where(eq(suggestions.asin, c.asin)).limit(1);
      if (rows.length > 0 && (rows[0].status === 'dismissed' || rows[0].status === 'added')) continue;
      if (rows.length > 0) {
        await this.db.update(suggestions).set({ score: c.score, reason: c.reason, reasonContext: c.reasonContext, refreshedAt: now }).where(eq(suggestions.id, rows[0].id));
      } else {
        await this.db.insert(suggestions).values({ ...c, status: 'pending', refreshedAt: now });
        added++;
      }
    }

    const staleIds = currentPending.filter(p => !regeneratedAsins.has(p.asin)).map(p => p.id);
    if (staleIds.length > 0) await this.db.delete(suggestions).where(inArray(suggestions.id, staleIds));

    this.log.info({ added, removed: staleIds.length, total: candidates.length }, 'Discovery refresh complete');
    return { added, removed: staleIds.length, warnings: [] };
  }

  async getSuggestions(filters?: { reason?: SuggestionReason; author?: string }): Promise<SuggestionRow[]> {
    const conds = [eq(suggestions.status, 'pending')];
    if (filters?.reason) conds.push(eq(suggestions.reason, filters.reason));
    if (filters?.author) conds.push(eq(suggestions.authorName, filters.author));
    return this.db.select().from(suggestions).where(and(...conds)).orderBy(desc(suggestions.score));
  }

  async dismissSuggestion(id: number): Promise<SuggestionRow | null> {
    const rows = await this.db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
    if (rows.length === 0) return null;
    const now = new Date();
    await this.db.update(suggestions).set({ status: 'dismissed', dismissedAt: now }).where(eq(suggestions.id, id));
    return { ...rows[0], status: 'dismissed', dismissedAt: now };
  }

  async addSuggestion(id: number): Promise<{ suggestion: SuggestionRow; book?: unknown; alreadyAdded?: boolean; duplicate?: boolean } | null> {
    const rows = await this.db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.status === 'added') return { suggestion: row, alreadyAdded: true };

    const dup = await this.bookService.findDuplicate(row.title, row.authorName, row.asin);
    if (dup) {
      await this.db.update(suggestions).set({ status: 'added' }).where(eq(suggestions.id, id));
      return { suggestion: { ...row, status: 'added' }, book: dup, duplicate: true };
    }

    const book = await this.bookService.create({ title: row.title, authorName: row.authorName, asin: row.asin });
    await this.db.update(suggestions).set({ status: 'added' }).where(eq(suggestions.id, id));
    return { suggestion: { ...row, status: 'added' }, book };
  }

  async getStats(): Promise<Record<string, number>> {
    const rows = await this.db.select({ reason: suggestions.reason, count: sql<number>`count(*)` }).from(suggestions).where(eq(suggestions.status, 'pending')).groupBy(suggestions.reason);
    const stats: Record<string, number> = {};
    for (const r of rows) stats[r.reason] = Number(r.count);
    return stats;
  }

  // -----------------------------------------------------------------------
  // Private — per-signal candidate queries
  // -----------------------------------------------------------------------

  private async queryAuthorCandidates(signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
    const top = [...signals.authorAffinity.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    for (const [, { name, strength }] of top) {
      try {
        const { books: results, warnings } = await this.metadataService.searchBooksForDiscovery(name, { maxResults: 25 });
        ctx.warnings.push(...warnings);
        const cap = new Map<string, number>();
        ctx.queriedAuthor = name;
        this.filterAndScore(results, 'author', () => `New from ${name} — you have ${signals.authorAffinity.get(name)?.count ?? 0} of their books`, strength, ctx, map, cap);
        ctx.queriedAuthor = undefined;
      } catch (e) { this.log.warn(e, `Discovery: author query failed for ${name}`); }
    }
  }

  private async querySeriesCandidates(signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
    for (const gap of signals.seriesGaps) {
      try {
        const { books: results, warnings } = await this.metadataService.searchBooksForDiscovery(`"${gap.seriesName} ${gap.authorName}"`);
        ctx.warnings.push(...warnings);
        const filtered = results.filter(b => {
          const s = b.series?.find(s => s.name?.toLowerCase() === gap.seriesName.toLowerCase());
          return s?.position != null && gap.missingPositions.includes(s.position);
        });
        const next = gap.maxOwned + 1;
        this.filterAndScore(filtered, 'series', (book) => {
          const pos = book.series?.find(s => s.name?.toLowerCase() === gap.seriesName.toLowerCase())?.position;
          return `Next in ${gap.seriesName} — you have books 1-${gap.maxOwned}${pos === next ? '' : ` (position ${pos})`}`;
        }, 1.0, ctx, map);
      } catch (e) { this.log.warn(e, `Discovery: series query failed for ${gap.seriesName}`); }
    }
  }

  private async queryGenreCandidates(signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
    const topGenres = [...signals.genreDistribution.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const libraryAuthors = new Set([...signals.authorAffinity.keys()]);
    for (const [genre] of topGenres) {
      try {
        const { books: results, warnings } = await this.metadataService.searchBooksForDiscovery(genre);
        ctx.warnings.push(...warnings);
        const filtered = results.filter(b => !b.authors?.[0]?.name || !libraryAuthors.has(b.authors[0].name));
        this.filterAndScore(filtered, 'genre', () => `Popular in ${genre} — your most-read genre`, 0.5, ctx, map);
      } catch (e) { this.log.warn(e, `Discovery: genre query failed for ${genre}`); }
    }
  }

  private async queryNarratorCandidates(signals: LibrarySignals, ctx: CandidateContext, map: Map<string, ScoredCandidate>) {
    for (const [name, count] of signals.narratorAffinity) {
      try {
        const { books: results, warnings } = await this.metadataService.searchBooksForDiscovery(name);
        ctx.warnings.push(...warnings);
        this.filterAndScore(results, 'narrator', () => `Narrated by ${name} — you've enjoyed ${count} of their performances`, Math.min(count / MAX_STRENGTH_BOOKS, 1.0), ctx, map);
      } catch (e) { this.log.warn(e, `Discovery: narrator query failed for ${name}`); }
    }
  }

  // -----------------------------------------------------------------------
  // Private — filtering + scoring
  // -----------------------------------------------------------------------

  private filterAndScore(
    results: BookMetadata[], reason: SuggestionReason, contextFn: (b: BookMetadata) => string,
    strength: number, ctx: CandidateContext, map: Map<string, ScoredCandidate>, authorCap?: Map<string, number>,
  ) {
    const eligible = results.filter(b => this.isEligibleCandidate(b, ctx, authorCap));
    for (const book of eligible) {
      const score = this.scoreCandidate(book, reason, strength, ctx.signals);
      const existing = map.get(book.asin!);
      if (!existing || score > existing.score) {
        map.set(book.asin!, this.toScoredCandidate(book, reason, contextFn(book), score));
      }
    }
  }

  private isEligibleCandidate(book: BookMetadata, ctx: CandidateContext, authorCap?: Map<string, number>): boolean {
    if (!book.asin) return false;
    if (ctx.existingAsins.has(book.asin) || ctx.dismissedAsins.has(book.asin)) return false;
    if (!book.language || book.language.toLowerCase() !== ctx.regionLang) return false;
    const candidateAuthor = book.authors?.[0]?.name ?? '';
    if (this.isTitleAuthorDuplicate(book.title, candidateAuthor, ctx.existingTitleAuthors)) return false;
    if (!this.isAuthorMatchClose(candidateAuthor, ctx.queriedAuthor)) return false;
    return this.checkAuthorCap(candidateAuthor, authorCap, ctx.maxPerAuthor);
  }

  private isAuthorMatchClose(candidateAuthor: string, queriedAuthor?: string): boolean {
    if (!queriedAuthor || !candidateAuthor) return true;
    return diceCoefficient(candidateAuthor, queriedAuthor) >= 0.6;
  }

  private checkAuthorCap(candidateAuthor: string, authorCap?: Map<string, number>, maxPerAuthor?: number): boolean {
    if (!authorCap || maxPerAuthor == null) return true;
    const key = candidateAuthor || 'unknown';
    const cnt = authorCap.get(key) ?? 0;
    if (cnt >= maxPerAuthor) return false;
    authorCap.set(key, cnt + 1);
    return true;
  }

  private isTitleAuthorDuplicate(title: string, authorName: string, existing: Array<{ title: string; author: string }>): boolean {
    for (const e of existing) {
      const titleSim = diceCoefficient(title, e.title);
      const authorSim = authorName && e.author ? diceCoefficient(authorName, e.author) : 0;
      if (titleSim >= 0.8 && authorSim >= 0.7) return true;
    }
    return false;
  }

  private toScoredCandidate(book: BookMetadata, reason: SuggestionReason, reasonContext: string, score: number): ScoredCandidate {
    return {
      asin: book.asin!, title: book.title, authorName: book.authors?.[0]?.name ?? 'Unknown',
      narratorName: book.narrators?.[0], coverUrl: book.coverUrl, duration: book.duration,
      publishedDate: book.publishedDate, language: book.language, genres: book.genres,
      seriesName: book.series?.[0]?.name, seriesPosition: book.series?.[0]?.position,
      reason, reasonContext, score,
    };
  }

  private scoreCandidate(book: BookMetadata, reason: SuggestionReason, strength: number, signals: LibrarySignals): number {
    let score = SIGNAL_WEIGHTS[reason] * strength;

    if (signals.durationStats && book.duration) {
      if (Math.abs(book.duration - signals.durationStats.median) <= signals.durationStats.stddev) score += 5;
    }
    if (book.publishedDate) {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      if (new Date(book.publishedDate) >= twoYearsAgo) score += 10;
    }
    if (reason === 'series' && book.series?.[0]?.name && book.series[0].position != null) {
      const gap = signals.seriesGaps.find(g => g.seriesName.toLowerCase() === book.series![0].name!.toLowerCase());
      if (gap && book.series[0].position === gap.maxOwned + 1) score += 20;
    }

    return Math.min(Math.max(score, 0), 100);
  }
}

interface CandidateContext {
  regionLang: string;
  existingAsins: Set<string>;
  existingTitleAuthors: Array<{ title: string; author: string }>;
  dismissedAsins: Set<string>;
  maxPerAuthor: number;
  signals: LibrarySignals;
  warnings: string[];
  queriedAuthor?: string;
}
