import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '@db/schema.js';
import {
  parseAudiobookTitle,
  scoreResult,
  type SearchResult,
  type SearchOptions,
} from '@core/index.js';
import type { SettingsService } from './settings.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { logIndexerSearchTrace } from './indexer-search-trace.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';
import { cleanIndexerQuery, cleanIndexerSearchOptions } from './indexer-query.js';
import type { IndexerService } from './indexer.service.js';
import type { IndexerRow } from './types.js';


export class IndexerSearchService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private indexerService: IndexerService,
    private settingsService?: SettingsService,
  ) {}

  private preSearchRefreshDeps() {
    return { log: this.log, update: (id: number, data: { settings: Record<string, unknown> }) => this.indexerService.update(id, data) };
  }

  /** Parse release names to extract author/title for results that don't already have them */
  private parseReleaseNames(results: SearchResult[], indexerName?: string): void {
    for (const result of results) {
      if (result.author) continue;
      const parsed = parseAudiobookTitle(result.title);
      if (parsed.title !== result.title || parsed.author) {
        result.rawTitle = result.title;
        result.title = parsed.title;
      }
      if (parsed.author) result.author = parsed.author;
      if (parsed.narrator && !result.narrator) result.narrator = parsed.narrator;
      if (!parsed.author && !/^[a-f0-9]{32,}$/i.test(result.title)) {
        this.log.debug({ rawTitle: result.rawTitle ?? result.title, indexerName }, 'Unparsed release name');
      }
    }
  }

  /** RSS-capable adapter types that support empty-query polling. */
  private static readonly RSS_CAPABLE_TYPES = ['newznab', 'torznab'];

  /** Get enabled indexers filtered to RSS-capable types. */
  async getRssCapableIndexers(): Promise<IndexerRow[]> {
    const all = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);
    return all.filter((i) => IndexerSearchService.RSS_CAPABLE_TYPES.includes(i.type));
  }

  /** Poll a single indexer with empty query (RSS feed). Returns results with parsed release names. */
  async pollRss(indexer: IndexerRow): Promise<SearchResult[]> {
    const adapter = await this.indexerService.getAdapter(indexer);
    const response = await adapter.search('');
    logIndexerSearchTrace(this.log, indexer, response);
    const results = response.results.map(r => ({ ...r, indexerId: indexer.id, indexerPriority: indexer.priority }));
    this.parseReleaseNames(results, indexer.name);
    return results;
  }

  async getEnabledIndexers(): Promise<Array<{ id: number; name: string }>> {
    const rows = await this.db
      .select({ id: indexers.id, name: indexers.name })
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);
    return rows;
  }

  /** Query all enabled indexer rows (full select) and inject language preferences into search options. */
  private async getEnabledIndexerRows(options?: SearchOptions) {
    const enabledIndexers = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);

    let searchOptions = options;
    if (this.settingsService && !options?.languages) {
      const metadataSettings = await this.settingsService.get('metadata');
      searchOptions = { ...options, languages: metadataSettings.languages };
    }

    return { enabledIndexers, searchOptions };
  }

  /**
   * Shared search preamble: clean transport query + options, fetch enabled indexers
   * with language injection. Returns null when query collapses to empty so callers
   * can short-circuit. Centralizes the transport-cleaning + short-circuit logic so
   * searchAll and searchAllStreaming can't drift apart on the load-bearing
   * transport/ranking split (#1015).
   */
  private async prepareSearch(
    query: string,
    options: SearchOptions | undefined,
    context: 'searchAll' | 'searchAllStreaming',
  ): Promise<{
    transportQuery: string;
    searchOptions: SearchOptions | undefined;
    enabledIndexers: IndexerRow[];
  } | null> {
    const transportQuery = cleanIndexerQuery(query);
    if (!transportQuery) {
      this.log.debug({ originalQuery: query, context }, 'Search skipped — query empty after normalization');
      return null;
    }
    const cleanedOptions = cleanIndexerSearchOptions(options);
    const { enabledIndexers, searchOptions } = await this.getEnabledIndexerRows(cleanedOptions);
    return { transportQuery, searchOptions, enabledIndexers };
  }

  /**
   * Shared scoring postamble: matchScore against RAW options (NOT cleaned
   * transport values) + sort descending. Centralizes the transport/ranking
   * split — scoreResult runs Dice on the result side raw, so cleaning the
   * context side asymmetrically would drop matchScore by 0.4-0.7 on
   * punctuated cases. See #1015.
   *
   * `rankingAuthor ?? author` (#2104 D8) is the same split applied one level
   * deeper: a query-relaxation rung that drops the author for TRANSPORT still
   * ranks against the canonical author, so results rank in the same order on an
   * author-OFF rung as on rung 1.
   */
  private applyMatchScore(results: SearchResult[], options: SearchOptions | undefined): void {
    if (!options?.title) return;
    const rankingAuthor = options.rankingAuthor ?? options.author;
    const context = { title: options.title, ...(rankingAuthor !== undefined && { author: rankingAuthor }) };
    for (const result of results) {
      result.matchScore = scoreResult(
        { title: result.title, ...(result.author !== undefined && { author: result.author }) },
        context,
      );
    }
    results.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  }

  /**
   * Aggregate search, results only. Thin wrapper over
   * {@link searchAllWithStatus} — the settlement counts are what the query
   * ladder needs and every pre-#2104 caller ignores.
   */
  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return (await this.searchAllWithStatus(query, options)).results;
  }

  /**
   * Aggregate search plus how many indexers ANSWERED.
   *
   * The fold below collapses a rejected indexer into `[]`, so an empty aggregate
   * cannot be distinguished from "everything failed" — and the query ladder
   * (#2104 D16) must not burn eight queries and a 24-hour cooldown during an
   * outage. `succeeded === 0` is an outage; `succeeded > 0 && results.length === 0`
   * is a real, answered zero.
   *
   * A query that normalizes away short-circuits with `succeeded: 0`, which the
   * ladder reads as "stop" — preserving the pre-ladder `prepareSearch`
   * short-circuit exactly.
   */
  async searchAllWithStatus(
    query: string,
    options?: SearchOptions,
  ): Promise<{ results: SearchResult[]; succeeded: number; failed: number }> {
    const prep = await this.prepareSearch(query, options, 'searchAll');
    if (!prep) return { results: [], succeeded: 0, failed: 0 };
    const { transportQuery, searchOptions, enabledIndexers } = prep;

    this.log.debug({ query: transportQuery, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Searching enabled indexers');

    const settlements = await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const adapter = await this.indexerService.getAdapter(indexer);

        const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps());
        if (refresh.skip) {
          this.log.warn({ indexer: indexer.name, error: refresh.error }, 'Indexer skipped by pre-search refresh');
          throw new Error(refresh.error ?? 'Indexer skipped');
        }

        const response = await adapter.search(transportQuery, searchOptions);
        logIndexerSearchTrace(this.log, indexer, response);
        const mapped = response.results.map(r => ({ ...r, indexerId: indexer.id, indexerPriority: indexer.priority }));
        this.parseReleaseNames(mapped, indexer.name);
        return mapped;
      }),
    );

    const perIndexerCounts: Record<string, number> = {};
    const results: SearchResult[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i]!;
      const name = enabledIndexers[i]!.name;
      if (settlement.status === 'fulfilled') {
        succeeded++;
        perIndexerCounts[name] = settlement.value.length;
        results.push(...settlement.value);
      } else {
        failed++;
        perIndexerCounts[name] = 0;
        this.log.warn({ indexer: name, query: transportQuery, error: serializeError(settlement.reason) }, 'Error searching indexer');
      }
    }

    this.log.debug({ query: transportQuery, indexerCount: enabledIndexers.length, perIndexerCounts }, 'Search aggregated across indexers');

    this.applyMatchScore(results, options);

    this.log.debug({ totalResults: results.length }, 'Search complete');
    return { results, succeeded, failed };
  }

  /**
   * Streaming search: calls per-indexer callbacks as each settles.
   * Returns aggregate results (same shape as searchAll) for post-processing.
   * Each indexer gets its own signal from the controllers map.
   */
  async searchAllStreaming(
    query: string,
    options: SearchOptions | undefined,
    controllers: Map<number, AbortController>,
    callbacks: {
      onComplete: (indexerId: number, name: string, resultCount: number, elapsedMs: number) => void;
      onError: (indexerId: number, name: string, error: string, elapsedMs: number) => void;
      onCancelled?: (indexerId: number, name: string) => void;
    },
  ): Promise<SearchResult[]> {
    const prep = await this.prepareSearch(query, options, 'searchAllStreaming');
    if (!prep) return [];
    const { transportQuery, searchOptions, enabledIndexers } = prep;

    this.log.debug({ query: transportQuery, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Streaming search started');

    const perIndexerResults = new Map<number, SearchResult[]>();

    await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        const controller = controllers.get(indexer.id);
        const signal = controller?.signal;

        // Pre-adapter abort guard (#2104 D11). Controllers are STICKY across the
        // query ladder's rungs, but the `signal?.aborted` classification below
        // lives only in the catch block — so without this an indexer the user
        // cancelled on rung 1 would be re-queried on every later rung. Emits no
        // callback: the indexer already displays as cancelled from the rung that
        // cancelled it, and a duplicate `indexer-cancelled` frame is noise.
        if (signal?.aborted) {
          this.log.debug({ indexer: indexer.name }, 'Indexer skipped — already cancelled');
          return;
        }

        try {
          const adapter = await this.indexerService.getAdapter(indexer);

          const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps());
          if (refresh.skip) {
            const elapsedMs = Date.now() - indexerStartMs;
            callbacks.onError(indexer.id, indexer.name, refresh.error ?? 'Indexer skipped', elapsedMs);
            return;
          }

          const response = await adapter.search(transportQuery, { ...searchOptions, signal });
          logIndexerSearchTrace(this.log, indexer, response);
          const elapsedMs = Date.now() - indexerStartMs;
          const mapped = response.results.map(r => ({ ...r, indexerId: indexer.id, indexerPriority: indexer.priority }));
          this.parseReleaseNames(mapped, indexer.name);
          perIndexerResults.set(indexer.id, mapped);
          callbacks.onComplete(indexer.id, indexer.name, mapped.length, elapsedMs);
        } catch (error: unknown) {
          const elapsedMs = Date.now() - indexerStartMs;
          // Cancelled indexers report as cancelled, not error
          if (signal?.aborted) {
            this.log.debug({ indexer: indexer.name }, 'Indexer search cancelled');
            callbacks.onCancelled?.(indexer.id, indexer.name);
            return;
          }
          const message = getErrorMessage(error);
          this.log.warn({ indexer: indexer.name, query: transportQuery, error: serializeError(error) }, 'Error searching indexer');
          callbacks.onError(indexer.id, indexer.name, message, elapsedMs);
        }
      }),
    );

    // Aggregate results from non-cancelled indexers
    const results: SearchResult[] = [];
    const perIndexerCounts: Record<string, number> = {};
    for (const indexer of enabledIndexers) {
      const indexerResults = perIndexerResults.get(indexer.id) ?? [];
      perIndexerCounts[indexer.name] = indexerResults.length;
      results.push(...indexerResults);
    }
    this.log.debug({ query: transportQuery, indexerCount: enabledIndexers.length, perIndexerCounts }, 'Search aggregated across indexers');

    this.applyMatchScore(results, options);

    this.log.debug({ totalResults: results.length }, 'Streaming search complete');
    return results;
  }
}
