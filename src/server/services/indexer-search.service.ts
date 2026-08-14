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


/** `AbortSignal.any` requires at least one input, and either side may be absent. */
function composeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

export class IndexerSearchService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private indexerService: IndexerService,
    private settingsService?: SettingsService,
  ) {}

  private preSearchRefreshDeps(signal?: AbortSignal) {
    return {
      log: this.log,
      update: (id: number, data: { settings: Record<string, unknown> }) => this.indexerService.update(id, data),
      signal,
    };
  }

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

  private static readonly RSS_CAPABLE_TYPES = ['newznab', 'torznab'];

  async getRssCapableIndexers(): Promise<IndexerRow[]> {
    const all = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);
    return all.filter((i) => IndexerSearchService.RSS_CAPABLE_TYPES.includes(i.type));
  }

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

  /** Load enabled rows and inject default languages when callers omit them. */
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

  /** Clean transport inputs once; null means the query normalized to empty. */
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
   * Score against raw context, never cleaned transport values; asymmetric cleaning destroys Dice
   * scores. rankingAuthor preserves canonical ranking on author-relaxed query rungs.
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

  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return (await this.searchAllWithStatus(query, options)).results;
  }

  /**
   * Distinguish an answered empty result from total outage: zero successes tells the query ladder
   * to stop. Queries that normalize empty also report zero settlements.
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

        const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps(searchOptions?.signal));
        if (refresh.skip) {
          this.log.warn({ indexer: indexer.name, error: refresh.error }, 'Indexer skipped by pre-search refresh');
          throw new Error(refresh.error ?? 'Indexer skipped');
        }

        const response = await adapter.search(transportQuery, searchOptions);
        logIndexerSearchTrace(this.log, indexer, response);
        // Stamp the refresh's observation where indexerId is stamped: it describes this search only.
        const mapped = response.results.map(r => ({
          ...r, indexerId: indexer.id, indexerPriority: indexer.priority,
          ...(refresh.unsatisfied !== undefined && { unsatisfied: refresh.unsatisfied }),
        }));
        this.parseReleaseNames(mapped, indexer.name);
        return mapped;
      }),
    );

    // Under an aborted signal every arm rejects, `succeeded` reads 0, and the ladder mistakes
    // cancellation for an indexer outage. Key on the signal, never on the error's shape.
    if (searchOptions?.signal?.aborted) {
      const cancelled = settlements.find((s) => s.status === 'rejected');
      if (cancelled) throw cancelled.reason;
    }

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

  /** Stream per-indexer settlement callbacks and return aggregate noncancelled results. */
  async searchAllStreaming(
    query: string,
    options: SearchOptions | undefined,
    controllers: Map<number, AbortController>,
    callbacks: {
      onComplete: (indexerId: number, name: string, resultCount: number, elapsedMs: number) => void;
      onError: (indexerId: number, name: string, error: string, elapsedMs: number) => void;
      onCancelled?: (indexerId: number, name: string) => void;
    },
    outerSignal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const prep = await this.prepareSearch(query, options, 'searchAllStreaming');
    if (!prep) return [];
    const { transportQuery, searchOptions, enabledIndexers } = prep;

    this.log.debug({ query: transportQuery, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Streaming search started');

    const perIndexerResults = new Map<number, SearchResult[]>();

    const settlements = await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        const controller = controllers.get(indexer.id);
        // Compose, never substitute: the per-indexer controller stays independently cancellable
        // and the outer deadline cannot be mistaken for one of its cancellations.
        const perIndexerSignal = controller?.signal;
        const signal = composeSignals(perIndexerSignal, outerSignal);

        // Controllers persist across ladder rungs; skip prior cancellations without another callback.
        if (perIndexerSignal?.aborted) {
          this.log.debug({ indexer: indexer.name }, 'Indexer skipped — already cancelled');
          return;
        }

        try {
          const adapter = await this.indexerService.getAdapter(indexer);

          const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps(signal));
          if (refresh.skip) {
            const elapsedMs = Date.now() - indexerStartMs;
            callbacks.onError(indexer.id, indexer.name, refresh.error ?? 'Indexer skipped', elapsedMs);
            return;
          }

          const response = await adapter.search(transportQuery, { ...searchOptions, signal });
          logIndexerSearchTrace(this.log, indexer, response);
          const elapsedMs = Date.now() - indexerStartMs;
          const mapped = response.results.map(r => ({
            ...r, indexerId: indexer.id, indexerPriority: indexer.priority,
            ...(refresh.unsatisfied !== undefined && { unsatisfied: refresh.unsatisfied }),
          }));
          this.parseReleaseNames(mapped, indexer.name);
          perIndexerResults.set(indexer.id, mapped);
          callbacks.onComplete(indexer.id, indexer.name, mapped.length, elapsedMs);
        } catch (error: unknown) {
          const elapsedMs = Date.now() - indexerStartMs;
          // One catch, two verdicts: the outer deadline must propagate, a per-indexer cancel must not.
          if (outerSignal?.aborted) throw error;
          if (perIndexerSignal?.aborted) {
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

    // Only the outer-deadline rethrow above rejects an arm; every other failure was routed to onError.
    const cancelled = settlements.find((s) => s.status === 'rejected');
    if (cancelled) throw cancelled.reason;

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
