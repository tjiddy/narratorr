import { eq, and, desc, sql, inArray, lt, isNull, or, lte as drizzleLte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { suggestions, books, authors } from '../../db/schema.js';
import { REGION_LANGUAGES, type BookMetadata } from '../../core/index.js';
import type { MetadataService } from './metadata.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { SuggestionReason } from '../../shared/schemas/discovery.js';
import { extractSignals } from './discovery-signals.js';
import { computeWeightMultipliers, DEFAULT_MULTIPLIERS, type DismissalStats, type WeightMultipliers } from './discovery-weights.js';
import {
  queryAuthorCandidates, querySeriesCandidates, queryGenreCandidates,
  queryNarratorCandidates, queryDiversityCandidates, scoreCandidate,
  type ScoredCandidate, type CandidateContext,
} from './discovery-candidates.js';
export { DIVERSITY_GENRES, type ScoredCandidate } from './discovery-candidates.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SuggestionRow = typeof suggestions.$inferSelect;

export type { SuggestionReason };

export interface LibrarySignals {
  authorAffinity: Map<string, { count: number; strength: number; name: string }>;
  genreDistribution: Map<string, number>;
  seriesGaps: Array<{ seriesName: string; authorName: string; missingPositions: number[]; maxOwned: number }>;
  narratorAffinity: Map<string, number>;
  durationStats: { median: number; stddev: number } | null;
}

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

  async generateCandidates(signals: LibrarySignals, multipliers?: WeightMultipliers): Promise<ScoredCandidate[]> {
    const settings = await this.settingsService.get('discovery');
    const metadataSettings = await this.settingsService.get('metadata');
    const regionLang = REGION_LANGUAGES[metadataSettings.audibleRegion] ?? 'english';
    const warnings: string[] = [];

    const existingRows = await this.db.select({ asin: books.asin, title: books.title, authorName: authors.name }).from(books).leftJoin(authors, eq(books.authorId, authors.id));
    const existingAsins = new Set(existingRows.filter(b => b.asin).map(b => b.asin!));
    const existingTitleAuthors = existingRows.map(b => ({ title: b.title, author: b.authorName ?? '' }));
    const dismissedRows = await this.db.select({ asin: suggestions.asin }).from(suggestions).where(eq(suggestions.status, 'dismissed'));
    const dismissedAsins = new Set(dismissedRows.map(s => s.asin));

    const effectiveMultipliers = multipliers ?? DEFAULT_MULTIPLIERS;
    const ctx: CandidateContext = { regionLang, existingAsins, existingTitleAuthors, dismissedAsins, maxPerAuthor: settings.maxSuggestionsPerAuthor, signals, warnings, queriedAuthor: undefined, multipliers: effectiveMultipliers };
    const map = new Map<string, ScoredCandidate>();
    const deps = { metadataService: this.metadataService, log: this.log };

    await queryAuthorCandidates(deps, signals, ctx, map);
    await querySeriesCandidates(deps, signals, ctx, map);
    await queryGenreCandidates(deps, signals, ctx, map);
    await queryNarratorCandidates(deps, signals, ctx, map);

    // Diversity: generate separately, resolve ASIN collisions, append survivors
    const diversityCandidates = await queryDiversityCandidates(deps, signals, ctx);
    for (const dc of diversityCandidates) {
      if (!map.has(dc.asin)) {
        map.set(dc.asin, dc);
      }
      // ASIN collision with affinity → skip (affinity wins), next diversity candidate already in list
    }

    for (const w of warnings) this.log.warn({ warning: w }, 'Discovery: metadata search warning');
    return [...map.values()];
  }

  async refreshSuggestions(): Promise<{ added: number; removed: number; warnings: string[] }> {
    const warnings: string[] = [];

    // Step 1: Expire old pending suggestions (AC1, AC5, AC8)
    const expired = await this.expireSuggestions(warnings);

    // Step 1b: Compute dismissal-based weight multipliers (#406)
    let multipliers = { ...DEFAULT_MULTIPLIERS };
    try {
      const stats = await this.computeDismissalStats();
      multipliers = computeWeightMultipliers(stats);
    } catch (error) {
      this.log.warn(error, 'Discovery: dismissal ratio computation failed — using default weights');
    }

    // Store computed multipliers in settings
    try {
      const currentSettings = await this.settingsService.get('discovery');
      await this.settingsService.set('discovery', { ...currentSettings, weightMultipliers: multipliers });
    } catch (error) {
      this.log.warn(error, 'Discovery: failed to persist weight multipliers — continuing with in-memory values');
    }

    // Step 2: Generate candidates
    const signals = await this.analyzeLibrary();
    const candidates = await this.generateCandidates(signals, multipliers);
    const currentPending = await this.db.select({
      id: suggestions.id,
      asin: suggestions.asin,
      snoozeUntil: suggestions.snoozeUntil,
      reason: suggestions.reason,
      reasonContext: suggestions.reasonContext,
      authorName: suggestions.authorName,
      narratorName: suggestions.narratorName,
      duration: suggestions.duration,
      publishedDate: suggestions.publishedDate,
      seriesName: suggestions.seriesName,
      seriesPosition: suggestions.seriesPosition,
    }).from(suggestions).where(eq(suggestions.status, 'pending'));
    const regeneratedAsins = new Set(candidates.map(c => c.asin));
    const now = new Date();

    // Step 3: Upsert candidates
    let added = 0;
    for (const c of candidates) {
      const rows = await this.db.select().from(suggestions).where(eq(suggestions.asin, c.asin)).limit(1);
      if (rows.length > 0 && (rows[0].status === 'dismissed' || rows[0].status === 'added')) continue;
      if (rows.length > 0) {
        // AC6: If row has snoozeUntil set, only update score + refreshedAt (preserve reason/reasonContext)
        if (rows[0].snoozeUntil != null) {
          // Clear snoozeUntil if it's in the past (resurfaced), keep if still active
          const clearSnooze = rows[0].snoozeUntil <= now ? { snoozeUntil: null } : {};
          await this.db.update(suggestions).set({ score: c.score, refreshedAt: now, ...clearSnooze }).where(eq(suggestions.id, rows[0].id));
        } else {
          await this.db.update(suggestions).set({ score: c.score, reason: c.reason, reasonContext: c.reasonContext, refreshedAt: now }).where(eq(suggestions.id, rows[0].id));
        }
      } else {
        await this.db.insert(suggestions).values({ ...c, status: 'pending', refreshedAt: now });
        added++;
      }
    }

    // Step 4: Handle resurfaced snoozed rows not regenerated by pipeline (AC6)
    const resurfacedSnoozed = currentPending.filter(p =>
      !regeneratedAsins.has(p.asin) && p.snoozeUntil != null && p.snoozeUntil <= now,
    );
    await this.resurfaceSnoozedRows(resurfacedSnoozed, signals, now, multipliers);
    const resurfacedIds = new Set(resurfacedSnoozed.map(r => r.id));

    // Step 5: Delete stale pending suggestions (exclude resurfaced + still-snoozed ones)
    const staleIds = currentPending
      .filter(p => !regeneratedAsins.has(p.asin) && !resurfacedIds.has(p.id) && !(p.snoozeUntil != null && p.snoozeUntil > now))
      .map(p => p.id);
    if (staleIds.length > 0) await this.db.delete(suggestions).where(inArray(suggestions.id, staleIds));

    this.log.info({ added, removed: staleIds.length, expired, total: candidates.length }, 'Discovery refresh complete');
    return { added, removed: staleIds.length, warnings };
  }

  private async expireSuggestions(warnings: string[]): Promise<number> {
    try {
      const settings = await this.settingsService.get('discovery');
      const cutoff = new Date(Date.now() - settings.expiryDays * 86400000);
      const result = await this.db.delete(suggestions).where(
        and(eq(suggestions.status, 'pending'), lt(suggestions.createdAt, cutoff)),
      );
      const expired = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
      if (expired > 0) this.log.info({ expired }, 'Discovery: expired stale suggestions');
      return expired;
    } catch (error) {
      this.log.warn(error, 'Discovery: expiry step failed');
      warnings.push('Expiry step failed — continuing with candidate generation');
      return 0;
    }
  }

  private async resurfaceSnoozedRows(
    rows: Array<{ id: number; asin: string; reason: string; authorName: string; narratorName: string | null; duration: number | null; publishedDate: string | null; seriesName: string | null; seriesPosition: number | null }>,
    signals: LibrarySignals, now: Date, multipliers: WeightMultipliers = DEFAULT_MULTIPLIERS,
  ) {
    for (const row of rows) {
      const reason = row.reason as SuggestionReason;
      const affinityKey = reason === 'narrator' ? (row.narratorName ?? row.authorName) : row.authorName;
      const strength = this.getStrengthForReason(reason, affinityKey, signals);
      const pseudoBook = {
        asin: row.asin, title: '', authors: [{ name: row.authorName }],
        duration: row.duration ?? undefined, publishedDate: row.publishedDate ?? undefined,
        series: row.seriesName ? [{ name: row.seriesName, position: row.seriesPosition ?? undefined }] : undefined,
      } as BookMetadata;
      const score = scoreCandidate(pseudoBook, reason, strength, signals, multipliers);
      await this.db.update(suggestions).set({ score, refreshedAt: now, snoozeUntil: null }).where(eq(suggestions.id, row.id));
    }
  }

  private getStrengthForReason(reason: SuggestionReason, authorName: string, signals: LibrarySignals): number {
    switch (reason) {
      case 'author': return signals.authorAffinity.get(authorName)?.strength ?? 0.5;
      case 'series': return 1.0;
      case 'genre': return 0.5;
      case 'narrator': {
        const count = signals.narratorAffinity.get(authorName) ?? 0;
        return Math.min(count / MAX_STRENGTH_BOOKS, 1.0);
      }
      case 'diversity': return 0.3;
    }
  }

  async getSuggestions(filters?: { reason?: SuggestionReason; author?: string }): Promise<SuggestionRow[]> {
    const now = new Date();
    const conds = [
      eq(suggestions.status, 'pending'),
      or(isNull(suggestions.snoozeUntil), drizzleLte(suggestions.snoozeUntil, now)),
    ];
    if (filters?.reason) conds.push(eq(suggestions.reason, filters.reason));
    if (filters?.author) conds.push(eq(suggestions.authorName, filters.author));
    return this.db.select().from(suggestions).where(and(...conds)).orderBy(desc(suggestions.score));
  }

  async snoozeSuggestion(id: number, durationDays: number): Promise<SuggestionRow | 'conflict' | null> {
    const rows = await this.db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
    if (rows.length === 0) return null;
    if (rows[0].status !== 'pending') return 'conflict';
    const snoozeUntil = new Date(Date.now() + durationDays * 86400000);
    await this.db.update(suggestions).set({ snoozeUntil }).where(eq(suggestions.id, id));
    return { ...rows[0], snoozeUntil };
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

  private async queryDismissalCounts(): Promise<Array<{ reason: string; status: string; count: number }>> {
    return this.db
      .select({
        reason: suggestions.reason,
        status: suggestions.status,
        count: sql<number>`count(*)`,
      })
      .from(suggestions)
      .where(inArray(suggestions.status, ['dismissed', 'added']))
      .groupBy(suggestions.reason, suggestions.status);
  }

  private parseDismissalCounts(rows: Array<{ reason: string; status: string; count: number }>): Map<string, { dismissed: number; added: number }> {
    const counts = new Map<string, { dismissed: number; added: number }>();
    for (const row of rows) {
      const entry = counts.get(row.reason) ?? { dismissed: 0, added: 0 };
      if (row.status === 'dismissed') entry.dismissed = Number(row.count);
      else if (row.status === 'added') entry.added = Number(row.count);
      counts.set(row.reason, entry);
    }
    return counts;
  }

  async computeDismissalRatios(): Promise<Partial<Record<SuggestionReason, number>>> {
    const rows = await this.queryDismissalCounts();
    const counts = this.parseDismissalCounts(rows);
    const ratios: Partial<Record<SuggestionReason, number>> = {};
    for (const [reason, { dismissed, added }] of counts) {
      const total = dismissed + added;
      ratios[reason as SuggestionReason] = total > 0 ? dismissed / total : 0;
    }
    return ratios;
  }

  private async computeDismissalStats(): Promise<Partial<Record<SuggestionReason, DismissalStats>>> {
    const rows = await this.queryDismissalCounts();
    const counts = this.parseDismissalCounts(rows);
    const stats: Partial<Record<SuggestionReason, DismissalStats>> = {};
    for (const [reason, { dismissed, added }] of counts) {
      stats[reason as SuggestionReason] = { dismissed, added, total: dismissed + added };
    }
    return stats;
  }

  async getStats(): Promise<Record<string, number>> {
    const rows = await this.db.select({ reason: suggestions.reason, count: sql<number>`count(*)` }).from(suggestions).where(eq(suggestions.status, 'pending')).groupBy(suggestions.reason);
    const stats: Record<string, number> = {};
    for (const r of rows) stats[r.reason] = Number(r.count);
    return stats;
  }

}
