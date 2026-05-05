import { eq, and, desc, sql, inArray, lt, isNull, or, lte as drizzleLte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { suggestions, books, authors, bookAuthors, bookNarrators, narrators } from '../../db/schema.js';
import type { BookMetadata } from '../../core/index.js';
import { chunkArray } from '../utils/batch.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { SuggestionReason } from '../../shared/schemas/discovery.js';
import type { SuggestionRow } from './types.js';
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

export type { SuggestionReason };

export interface LibrarySignals {
  authorAffinity: Map<string, { count: number; strength: number; name: string }>;
  genreDistribution: Map<string, number>;
  seriesGaps: Array<{ seriesName: string; authorName: string; missingPositions: number[]; maxOwned: number; nextPosition: number }>;
  narratorAffinity: Map<string, number>;
  durationStats: { median: number; stddev: number } | null;
}

const MAX_STRENGTH_BOOKS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DiscoveryService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService: MetadataService,
    private settingsService: SettingsService,
  ) {}

  async analyzeLibrary(): Promise<LibrarySignals> {
    const bookRows = await this.db
      .select({ book: books, authorName: authors.name })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(books.status, 'imported'));

    const narratorRows = await this.db
      .select({ bookId: bookNarrators.bookId, narratorName: narrators.name })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id));

    return extractSignals(bookRows, narratorRows);
  }

  async generateCandidates(signals: LibrarySignals, multipliers?: WeightMultipliers): Promise<ScoredCandidate[]> {
    const settings = await this.settingsService.get('discovery');
    const metadataSettings = await this.settingsService.get('metadata');
    const languages = metadataSettings.languages;
    const warnings: string[] = [];

    const existingRows = await this.db
      .select({ asin: books.asin, title: books.title, authorName: authors.name })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id));
    const existingAsins = new Set(existingRows.filter(b => b.asin).map(b => b.asin!));
    const existingTitleAuthors = existingRows.map(b => ({ title: b.title, author: b.authorName ?? '' }));
    const dismissedRows = await this.db.select({ asin: suggestions.asin }).from(suggestions).where(eq(suggestions.status, 'dismissed'));
    const dismissedAsins = new Set(dismissedRows.map(s => s.asin));

    const effectiveMultipliers = multipliers ?? DEFAULT_MULTIPLIERS;
    const ctx: CandidateContext = { languages, existingAsins, existingTitleAuthors, dismissedAsins, maxPerAuthor: settings.maxSuggestionsPerAuthor, signals, warnings, multipliers: effectiveMultipliers };
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
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Discovery: dismissal ratio computation failed — using default weights');
    }

    // Store computed multipliers in settings
    try {
      const currentSettings = await this.settingsService.get('discovery');
      await this.settingsService.set('discovery', { ...currentSettings, weightMultipliers: multipliers });
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Discovery: failed to persist weight multipliers — continuing with in-memory values');
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

    // Step 3: Batch upsert candidates (#554)
    const added = await this.batchUpsertCandidates(candidates, now);

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
      const expired = getRowsAffected(result);
      if (expired > 0) this.log.info({ expired }, 'Discovery: expired stale suggestions');
      return expired;
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Discovery: expiry step failed');
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

  private async batchUpsertCandidates(candidates: ScoredCandidate[], now: Date): Promise<number> {
    if (candidates.length === 0) return 0;

    const candidateAsins = candidates.map(c => c.asin);
    const existingRows: Array<{ asin: string; status: string; snoozeUntil: Date | null }> = [];
    // SQLite bind-param limit is 999 — chunk read-side SELECTs to stay under
    for (const chunk of chunkArray(candidateAsins, 999)) {
      const rows = await this.db.select({
        asin: suggestions.asin,
        status: suggestions.status,
        snoozeUntil: suggestions.snoozeUntil,
      }).from(suggestions).where(inArray(suggestions.asin, chunk));
      existingRows.push(...rows);
    }

    const existingByAsin = new Map(existingRows.map(r => [r.asin, r]));

    const toUpsert = candidates.filter(c => {
      const existing = existingByAsin.get(c.asin);
      return !existing || (existing.status !== 'dismissed' && existing.status !== 'added');
    });

    let added = 0;
    for (const c of toUpsert) {
      if (!existingByAsin.has(c.asin)) added++;
    }

    // 47 rows × ~20 bind params per row ≈ 940, safely under the SQLite 999 limit
    const WRITE_CHUNK_SIZE = 47;
    for (const chunk of chunkArray(toUpsert, WRITE_CHUNK_SIZE)) {
      await this.db.insert(suggestions)
        .values(chunk.map(c => ({ ...c, status: 'pending' as const, refreshedAt: now })))
        .onConflictDoUpdate({
          target: suggestions.asin,
          set: {
            // `excluded.*` references the SQLite column names (snake_case),
            // not the Drizzle JS field names. Quoted camelCase identifiers
            // resolve to "no such column" errors at runtime.
            score: sql`excluded.score`,
            authorAsin: sql`excluded.author_asin`,
            refreshedAt: sql`excluded.refreshed_at`,
            reason: sql`CASE WHEN ${suggestions.snoozeUntil} IS NOT NULL THEN ${suggestions.reason} ELSE excluded.reason END`,
            reasonContext: sql`CASE WHEN ${suggestions.snoozeUntil} IS NOT NULL THEN ${suggestions.reasonContext} ELSE excluded.reason_context END`,
            snoozeUntil: sql`CASE WHEN ${suggestions.snoozeUntil} IS NOT NULL AND ${suggestions.snoozeUntil} <= excluded.refreshed_at THEN NULL ELSE ${suggestions.snoozeUntil} END`,
          },
        });
    }

    return added;
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

  async getSuggestions(filters?: { reason?: SuggestionReason | undefined; author?: string | undefined } | undefined): Promise<SuggestionRow[]> {
    const now = new Date();
    const conds = [
      eq(suggestions.status, 'pending'),
      or(isNull(suggestions.snoozeUntil), drizzleLte(suggestions.snoozeUntil, now)),
    ];
    if (filters?.reason) conds.push(eq(suggestions.reason, filters.reason));
    if (filters?.author) conds.push(eq(suggestions.authorName, filters.author));
    return this.db.select().from(suggestions).where(and(...conds)).orderBy(desc(suggestions.score));
  }

  async dismissSuggestion(id: number): Promise<SuggestionRow | null> {
    const rows = await this.db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
    if (rows.length === 0) return null;
    const now = new Date();
    await this.db.update(suggestions).set({ status: 'dismissed', dismissedAt: now }).where(eq(suggestions.id, id));
    return { ...rows[0]!, status: 'dismissed', dismissedAt: now };
  }

  async markSuggestionAdded(id: number): Promise<{ suggestion: SuggestionRow; alreadyAdded?: boolean; invalidStatus?: boolean } | null> {
    const rows = await this.db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.status === 'added') return { suggestion: row, alreadyAdded: true };
    if (row.status !== 'pending') return { suggestion: row, invalidStatus: true };

    await this.db.update(suggestions).set({ status: 'added' }).where(eq(suggestions.id, id));
    return { suggestion: { ...row, status: 'added' as const } };
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

}
