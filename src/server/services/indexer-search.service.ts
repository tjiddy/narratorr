import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '../../db/schema.js';
import {
  parseAudiobookTitle,
  scoreResult,
  type SearchResult,
  type SearchOptions,
} from '../../core/index.js';
import type { SettingsService } from './settings.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { logIndexerSearchTrace } from './indexer-search-trace.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';
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

  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const { enabledIndexers, searchOptions } = await this.getEnabledIndexerRows(options);

    this.log.debug({ query, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Searching enabled indexers');

    const settlements = await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const adapter = await this.indexerService.getAdapter(indexer);

        const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps());
        if (refresh.skip) {
          this.log.warn({ indexer: indexer.name, error: refresh.error }, 'Indexer skipped by pre-search refresh');
          throw new Error(refresh.error ?? 'Indexer skipped');
        }

        const response = await adapter.search(query, searchOptions);
        logIndexerSearchTrace(this.log, indexer, response);
        const mapped = response.results.map(r => ({ ...r, indexerId: indexer.id, indexerPriority: indexer.priority }));
        this.parseReleaseNames(mapped, indexer.name);
        return mapped;
      }),
    );

    const perIndexerCounts: Record<string, number> = {};
    const results: SearchResult[] = [];
    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i]!;
      const name = enabledIndexers[i]!.name;
      if (settlement.status === 'fulfilled') {
        perIndexerCounts[name] = settlement.value.length;
        results.push(...settlement.value);
      } else {
        perIndexerCounts[name] = 0;
        this.log.warn({ indexer: name, query, error: serializeError(settlement.reason) }, 'Error searching indexer');
      }
    }

    this.log.debug({ query, indexerCount: enabledIndexers.length, perIndexerCounts }, 'Search aggregated across indexers');

    // Score results against search context when title is provided
    if (options?.title) {
      const context = { title: options.title, author: options.author };
      for (const result of results) {
        result.matchScore = scoreResult(
          { title: result.title, author: result.author },
          context,
        );
      }
      // Sort by matchScore descending
      results.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
    }

    this.log.debug({ totalResults: results.length }, 'Search complete');
    return results;
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
    const { enabledIndexers, searchOptions } = await this.getEnabledIndexerRows(options);

    this.log.debug({ query, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Streaming search started');

    const perIndexerResults = new Map<number, SearchResult[]>();

    await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        const controller = controllers.get(indexer.id);
        const signal = controller?.signal;

        try {
          const adapter = await this.indexerService.getAdapter(indexer);

          const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps());
          if (refresh.skip) {
            const elapsedMs = Date.now() - indexerStartMs;
            callbacks.onError(indexer.id, indexer.name, refresh.error ?? 'Indexer skipped', elapsedMs);
            return;
          }

          const response = await adapter.search(query, { ...searchOptions, signal });
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
          this.log.warn({ indexer: indexer.name, query, error: serializeError(error) }, 'Error searching indexer');
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
    this.log.debug({ query, indexerCount: enabledIndexers.length, perIndexerCounts }, 'Search aggregated across indexers');

    // Score results
    if (options?.title) {
      const context = { title: options.title, author: options.author };
      for (const result of results) {
        result.matchScore = scoreResult(
          { title: result.title, author: result.author },
          context,
        );
      }
      results.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
    }

    this.log.debug({ totalResults: results.length }, 'Streaming search complete');
    return results;
  }
}
