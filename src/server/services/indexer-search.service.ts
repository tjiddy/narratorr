import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '@db/schema.js';
import {
  parseAudiobookTitle,
  scoreResult,
  type IndexerAdapter,
  type SearchResult,
  type SearchOptions,
} from '@core/index.js';
import type { UnsatisfiedStatus } from '@core/utils/mam-unsatisfied.js';
import type { SettingsService } from './settings.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { logIndexerSearchTrace } from './indexer-search-trace.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';
import { cleanIndexerQuery, cleanIndexerQueryKeepingApostrophes, cleanIndexerSearchOptions } from './indexer-query.js';
import type { IndexerService } from './indexer.service.js';
import { deliverSearchReport } from './search-event-sink.js';
import {
  describeIndexerSkip,
  formatIndexerSkip,
  type IndexerSkip,
} from './indexer-failure-state.js';
import type { IndexerLegOutcome, IndexerRunOptions } from './search-run-exclusion.js';
import type { IndexerRow } from './types.js';

export type { IndexerSkip } from './indexer-failure-state.js';

export interface AggregateSearchStatus {
  results: SearchResult[];
  succeeded: number;
  failed: number;
  /**
   * Breaker-suppressed indexers. Counted here and NOWHERE else: `succeeded` would make an
   * all-suppressed search read as an answered zero and march the ladder through all eight rungs
   * (the amplification path #2376 exists to close), and `failed` means "tried and broke".
   */
  skipped: IndexerSkip[];
}

/** `AbortSignal.any` requires at least one input, and either side may be absent. */
function composeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

/**
 * The abort verdict is the signal's, never the settlements' shape: an adapter that fulfils after
 * the deadline fired would otherwise read as an answered search, and the abandoned ladder would
 * advance a rung and issue more indexer requests. A real rejection is preferred as the reason only
 * because it carries more detail than the bare abort.
 */
function abortReason(settlements: PromiseSettledResult<unknown>[], signal: AbortSignal): unknown {
  const rejected = settlements.find((s) => s.status === 'rejected');
  if (rejected) return rejected.reason;
  return signal.reason ?? new DOMException('Search aborted', 'AbortError');
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
      // The non-clearing writer: this fires mid-leg, after the gate has been reserved, so the
      // clearing mutator would bump the generation and discard this very leg's outcome (AC17).
      update: (id: number, data: { settings: Record<string, unknown> }) => this.indexerService.persistObservedSettings(id, data.settings),
      signal,
    };
  }

  /**
   * AC21's gate, and the one place a skip is reported. Synchronous by contract — every caller
   * invokes it as the first statement of its per-indexer leg, before any `await`, so a reopened
   * window admits exactly one attempt process-wide across all three entry points.
   */
  private reserveIndexerLeg(indexer: IndexerRow): { allowed: true; generation: number } | { allowed: false; skip: IndexerSkip } {
    const decision = this.indexerService.reserveSearchAttempt(indexer.id);
    if (decision.allowed) return { allowed: true, generation: decision.generation };

    const skip = describeIndexerSkip(indexer.id, indexer.name, decision.snapshot);
    // `info`, not `debug`: two of the three entry points have no sink at all, and a silent skip
    // that makes a wanted book unobtainable must stay visible without enabling debug.
    this.log.info(
      {
        indexer: indexer.name,
        indexerId: indexer.id,
        breakerState: skip.state,
        reason: skip.reason,
        nextAttemptAt: decision.snapshot.nextAttemptAt,
      },
      'Indexer search skipped — breaker open',
    );
    return { allowed: false, skip };
  }

  /**
   * The failure arm of every leg. Cancellation is neither a success nor a failure: the verdict
   * is the signal's, never the error's shape, or a slow-but-working indexer would trip its own
   * breaker every time the book deadline fired.
   */
  private commitLegFailure(indexer: IndexerRow, error: unknown, generation: number, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    this.indexerService.recordSearchFailure(indexer.id, error, generation);
  }

  /** Every consumer callback goes through here; see `deliverSearchReport` for why. */
  private deliverLegReport(indexer: IndexerRow, report: () => void): void {
    deliverSearchReport(this.log, { indexer: indexer.name, indexerId: indexer.id }, report);
  }

  /**
   * AC18's channel: the structural verdict for one leg, emitted by the branch that already knows
   * it. Every caller emits BEFORE its operator-facing report, so a consumer that throws costs the
   * operator a line but never the run's exclusion decision.
   */
  private reportLegOutcome(indexer: IndexerRow, run: IndexerRunOptions | undefined, outcome: IndexerLegOutcome): void {
    const onOutcome = run?.onOutcome;
    if (!onOutcome) return;
    this.deliverLegReport(indexer, () => onOutcome(indexer.id, indexer.name, outcome));
  }

  /**
   * Cancellation is neither a success nor a failure, and the verdict is the signal's rather than
   * the error's shape — the same rule `commitLegFailure` applies, for the same reason.
   */
  private legFailureOutcome(error: unknown, elapsedMs: number, signal?: AbortSignal): IndexerLegOutcome {
    if (signal?.aborted) return { kind: 'cancelled' };
    return { kind: 'failed', error, report: { reason: getErrorMessage(error), elapsedMs } };
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

  /** `skipped` is present only when the breaker suppressed the poll, so its one caller can tell
   *  a real empty feed from a zero-I/O skip. */
  async pollRss(indexer: IndexerRow): Promise<{ results: SearchResult[]; skipped?: IndexerSkip }> {
    const gate = this.reserveIndexerLeg(indexer);
    if (!gate.allowed) return { results: [], skipped: gate.skip };

    try {
      const adapter = await this.indexerService.getAdapter(indexer);
      const response = await adapter.search('');
      this.indexerService.recordSearchSuccess(indexer.id, gate.generation);
      logIndexerSearchTrace(this.log, indexer, response);
      const results = response.results.map(r => ({ ...r, indexerId: indexer.id, indexerPriority: indexer.priority }));
      this.parseReleaseNames(results, indexer.name);
      return { results };
    } catch (error: unknown) {
      this.commitLegFailure(indexer, error, gate.generation);
      throw error;
    }
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
    excludeIndexerIds?: ReadonlySet<number>,
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
    // A ladder rung supplies its own, carrying the variant text the rung was actually built from;
    // every other caller gets it derived from this call's own raw query (#2422).
    const withApostrophes: SearchOptions = {
      ...cleanedOptions,
      queryWithApostrophes: options?.queryWithApostrophes ?? cleanIndexerQueryKeepingApostrophes(query),
    };
    const { enabledIndexers, searchOptions } = await this.getEnabledIndexerRows(withApostrophes);
    // Before the fan-out, not inside it: a run-excluded indexer must cost zero I/O, not a request
    // that is started and discarded. An emptied set reports zero successes with no adapter call.
    const eligible = excludeIndexerIds?.size
      ? enabledIndexers.filter((indexer) => !excludeIndexerIds.has(indexer.id))
      : enabledIndexers;
    return { transportQuery, searchOptions, enabledIndexers: eligible };
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
    run?: IndexerRunOptions,
  ): Promise<AggregateSearchStatus> {
    const prep = await this.prepareSearch(query, options, 'searchAll', run?.excludeIndexerIds);
    if (!prep) return { results: [], succeeded: 0, failed: 0, skipped: [] };
    const { transportQuery, searchOptions, enabledIndexers } = prep;

    this.log.debug({ query: transportQuery, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Searching enabled indexers');

    const skipped: IndexerSkip[] = [];
    const settlements = await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        // First statement, before any await: allSettled starts every callback synchronously up
        // to its first await, which is what makes the gate atomic across the fan-out.
        const gate = this.reserveIndexerLeg(indexer);
        if (!gate.allowed) {
          skipped.push(gate.skip);
          this.reportLegOutcome(indexer, run, {
            kind: 'breaker-suppressed',
            report: { reason: formatIndexerSkip(gate.skip.state, gate.skip.reason), elapsedMs: 0 },
          });
          return null;
        }

        let adapter;
        let refresh;
        try {
          adapter = await this.indexerService.getAdapter(indexer);
          refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps(searchOptions?.signal));
        } catch (error: unknown) {
          this.commitLegFailure(indexer, error, gate.generation, searchOptions?.signal);
          this.reportLegOutcome(indexer, run, this.legFailureOutcome(error, Date.now() - indexerStartMs, searchOptions?.signal));
          throw error;
        }

        if (refresh.skip) {
          // A policy refusal, not a transport failure: the indexer is reachable and no breaker
          // can improve the operator's own account class, so nothing is recorded. The throw stays
          // — it is what puts this leg in `failed` — but the kind travels beside it, because a
          // plain Error is by design indistinguishable from a genuine failure downstream.
          const reason = refresh.error ?? 'Indexer skipped';
          this.log.warn({ indexer: indexer.name, error: refresh.error }, 'Indexer skipped by pre-search refresh');
          this.reportLegOutcome(indexer, run, { kind: 'policy-refused', report: { reason, elapsedMs: Date.now() - indexerStartMs } });
          throw new Error(reason);
        }

        try {
          const response = await adapter.search(transportQuery, searchOptions);
          this.indexerService.recordSearchSuccess(indexer.id, gate.generation);
          logIndexerSearchTrace(this.log, indexer, response);
          // Stamp the refresh's observation where indexerId is stamped: it describes this search only.
          const mapped = response.results.map(r => ({
            ...r, indexerId: indexer.id, indexerPriority: indexer.priority,
            ...(refresh.unsatisfied !== undefined && { unsatisfied: refresh.unsatisfied }),
          }));
          this.parseReleaseNames(mapped, indexer.name);
          this.reportLegOutcome(indexer, run, { kind: 'resolved' });
          return mapped;
        } catch (error: unknown) {
          this.commitLegFailure(indexer, error, gate.generation, searchOptions?.signal);
          this.reportLegOutcome(indexer, run, this.legFailureOutcome(error, Date.now() - indexerStartMs, searchOptions?.signal));
          throw error;
        }
      }),
    );

    // Cancellation is not an outage and not an answer: whatever the adapters did, an aborted
    // signal terminates here rather than letting the ladder read a result set.
    if (searchOptions?.signal?.aborted) throw abortReason(settlements, searchOptions.signal);

    const perIndexerCounts: Record<string, number> = {};
    const results: SearchResult[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i]!;
      const name = enabledIndexers[i]!.name;
      if (settlement.status === 'fulfilled') {
        const value = settlement.value;
        // A suppressed leg fulfils with null: neither tried nor broke, so neither counter moves.
        perIndexerCounts[name] = value?.length ?? 0;
        if (value === null) continue;
        succeeded++;
        results.push(...value);
      } else {
        failed++;
        perIndexerCounts[name] = 0;
        this.log.warn({ indexer: name, query: transportQuery, error: serializeError(settlement.reason) }, 'Error searching indexer');
      }
    }

    this.log.debug({ query: transportQuery, indexerCount: enabledIndexers.length, perIndexerCounts }, 'Search aggregated across indexers');

    this.applyMatchScore(results, options);

    this.log.debug({ totalResults: results.length }, 'Search complete');
    return { results, succeeded, failed, skipped };
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
    run?: IndexerRunOptions,
  ): Promise<SearchResult[]> {
    const prep = await this.prepareSearch(query, options, 'searchAllStreaming', run?.excludeIndexerIds);
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
          this.reportLegOutcome(indexer, run, { kind: 'cancelled' });
          return;
        }

        const report = (deliver: () => void) => this.deliverLegReport(indexer, deliver);

        // Before any await, so a reopened gate admits exactly one leg across the fan-out.
        const gate = this.reserveIndexerLeg(indexer);
        if (!gate.allowed) {
          // The existing error channel, so the skip reaches SearchEventSink.indexerError and the
          // `indexer-error` SSE frame with no new wire event. elapsedMs 0 marks a zero-I/O skip.
          const skipReport = { reason: formatIndexerSkip(gate.skip.state, gate.skip.reason), elapsedMs: 0 };
          this.reportLegOutcome(indexer, run, { kind: 'breaker-suppressed', report: skipReport });
          report(() => callbacks.onError(indexer.id, indexer.name, skipReport.reason, skipReport.elapsedMs));
          return;
        }

        // The try wraps the TRANSPORT only. Everything after it — parsing, and every consumer
        // callback — used to sit inside, so a throwing SSE consumer committed a transport
        // failure and circuit-broke a healthy indexer.
        let settled: { response: Awaited<ReturnType<IndexerAdapter['search']>>; unsatisfied?: UnsatisfiedStatus; elapsedMs: number };
        try {
          const adapter = await this.indexerService.getAdapter(indexer);

          const refresh = await preSearchRefresh(adapter, indexer, this.preSearchRefreshDeps(signal));
          if (refresh.skip) {
            // A policy refusal is not a transport failure; nothing is recorded (AC14).
            const refusal = { reason: refresh.error ?? 'Indexer skipped', elapsedMs: Date.now() - indexerStartMs };
            this.reportLegOutcome(indexer, run, { kind: 'policy-refused', report: refusal });
            report(() => callbacks.onError(indexer.id, indexer.name, refusal.reason, refusal.elapsedMs));
            return;
          }

          const response = await adapter.search(transportQuery, { ...searchOptions, signal });
          this.indexerService.recordSearchSuccess(indexer.id, gate.generation);
          settled = {
            response,
            ...(refresh.unsatisfied !== undefined && { unsatisfied: refresh.unsatisfied }),
            elapsedMs: Date.now() - indexerStartMs,
          };
        } catch (error: unknown) {
          const elapsedMs = Date.now() - indexerStartMs;
          // A cancelled leg is neither a success nor a failure, whichever signal cancelled it.
          this.commitLegFailure(indexer, error, gate.generation, signal);
          // One catch, two verdicts: the outer deadline must propagate, a per-indexer cancel must not.
          // Both are cancellations though, so both report the kind before diverging — the aggregate
          // path reaches the same verdict through `legFailureOutcome`, and parity is the contract.
          if (outerSignal?.aborted) {
            this.reportLegOutcome(indexer, run, { kind: 'cancelled' });
            throw error;
          }
          if (perIndexerSignal?.aborted) {
            this.log.debug({ indexer: indexer.name }, 'Indexer search cancelled');
            this.reportLegOutcome(indexer, run, { kind: 'cancelled' });
            report(() => callbacks.onCancelled?.(indexer.id, indexer.name));
            return;
          }
          const message = getErrorMessage(error);
          this.log.warn({ indexer: indexer.name, query: transportQuery, error: serializeError(error) }, 'Error searching indexer');
          this.reportLegOutcome(indexer, run, { kind: 'failed', error, report: { reason: message, elapsedMs } });
          report(() => callbacks.onError(indexer.id, indexer.name, message, elapsedMs));
          return;
        }

        logIndexerSearchTrace(this.log, indexer, settled.response);
        const mapped = settled.response.results.map(r => ({
          ...r, indexerId: indexer.id, indexerPriority: indexer.priority,
          ...(settled.unsatisfied !== undefined && { unsatisfied: settled.unsatisfied }),
        }));
        this.parseReleaseNames(mapped, indexer.name);
        // Recorded before the callback, so a throwing consumer cannot lose this leg's results.
        perIndexerResults.set(indexer.id, mapped);
        this.reportLegOutcome(indexer, run, { kind: 'resolved' });
        report(() => callbacks.onComplete(indexer.id, indexer.name, mapped.length, settled.elapsedMs));
      }),
    );

    // Same verdict as the aggregate path, and for the same reason: an adapter that fulfilled after
    // the abort must not hand the abandoned ladder a result set to advance on. A per-indexer
    // cancellation leaves `outerSignal` un-aborted and still routes through `onCancelled` above.
    if (outerSignal?.aborted) throw abortReason(settlements, outerSignal);

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
