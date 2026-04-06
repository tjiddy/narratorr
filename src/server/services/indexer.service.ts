import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '../../db/schema.js';
import {
  INDEXER_ADAPTER_FACTORIES,
  parseAudiobookTitle,
  scoreResult,
  type IndexerAdapter,
  type SearchResult,
  type SearchOptions,
} from '../../core/index.js';
import type { SettingsService } from './settings.service.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey } from '../utils/secret-codec.js';
import { AdapterCache } from '../utils/adapter-cache.js';

type IndexerRow = typeof indexers.$inferSelect;
type NewIndexer = typeof indexers.$inferInsert;

export class IndexerService {
  private adapters = new AdapterCache<IndexerAdapter>();

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private settingsService?: SettingsService,
  ) {}

  private decryptRow(row: IndexerRow): IndexerRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('indexer', s, getKey()) };
  }

  async getAll(): Promise<IndexerRow[]> {
    const rows = await this.db.select().from(indexers).orderBy(indexers.priority);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<IndexerRow | null> {
    const results = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async create(data: Omit<NewIndexer, 'id' | 'createdAt'>): Promise<IndexerRow> {
    const toInsert = { ...data };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('indexer', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(indexers).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Indexer created');
    return this.decryptRow(result[0]);
  }

  async update(id: number, data: Partial<NewIndexer>): Promise<IndexerRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>);
      toUpdate.settings = encryptFields('indexer', settings, getKey());
    }
    const result = await this.db
      .update(indexers)
      .set(toUpdate)
      .where(eq(indexers.id, id))
      .returning();

    // Clear cached adapter
    this.adapters.delete(id);

    this.log.info({ id }, 'Indexer updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(indexers).where(eq(indexers.id, id));
    this.adapters.delete(id);
    this.log.info({ id }, 'Indexer deleted');
    return true;
  }

  /** Find an existing Prowlarr-sourced indexer by sourceIndexerId */
  async findByProwlarrSource(sourceIndexerId: number): Promise<IndexerRow | null> {
    const results = await this.db
      .select()
      .from(indexers)
      .where(and(eq(indexers.source, 'prowlarr'), eq(indexers.sourceIndexerId, sourceIndexerId)))
      .limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  /** Create or upsert a Prowlarr-sourced indexer (AC7, AC9) */
  async createOrUpsertProwlarr(data: {
    name: string;
    type: NewIndexer['type'];
    enabled: boolean;
    priority: number;
    settings: Record<string, unknown>;
    sourceIndexerId: number | null;
  }): Promise<{ row: IndexerRow; upserted: boolean }> {
    // If sourceIndexerId is non-null, check for existing row to upsert
    if (data.sourceIndexerId !== null) {
      const existing = await this.findByProwlarrSource(data.sourceIndexerId);
      if (existing) {
        // Upsert: overwrite Prowlarr-managed fields, preserve local-only fields
        // Merge settings: incoming Prowlarr keys overwrite, but local-only keys are kept
        const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
        const mergedSettings = { ...existingSettings, ...data.settings };
        const updated = await this.update(existing.id, {
          name: data.name,
          type: data.type,
          settings: mergedSettings,
          source: 'prowlarr',
          sourceIndexerId: data.sourceIndexerId,
          // Preserve: priority, enabled from existing row
        });
        this.log.info({ id: existing.id, sourceIndexerId: data.sourceIndexerId }, 'Prowlarr indexer upserted');
        return { row: updated!, upserted: true };
      }
    }

    // Insert new row
    const row = await this.create({
      name: data.name,
      type: data.type,
      enabled: data.enabled,
      priority: data.priority,
      settings: data.settings,
      source: 'prowlarr',
      sourceIndexerId: data.sourceIndexerId,
    });
    return { row, upserted: false };
  }

  private async getProxyUrl(): Promise<string | undefined> {
    if (!this.settingsService) return undefined;
    const network = await this.settingsService.get('network');
    return network.proxyUrl || undefined;
  }

  async getAdapter(indexer: IndexerRow): Promise<IndexerAdapter> {
    let adapter = this.adapters.get(indexer.id);

    if (!adapter) {
      const proxyUrl = await this.getProxyUrl();
      // Ensure settings are decrypted before creating the adapter
      const decrypted = this.decryptRow(indexer);
      adapter = this.createAdapter(decrypted, proxyUrl);
      this.adapters.set(indexer.id, adapter);
    }

    return adapter;
  }

  private createAdapter(indexer: IndexerRow, proxyUrl?: string): IndexerAdapter {
    const settings = indexer.settings as Record<string, unknown>;
    const factory = INDEXER_ADAPTER_FACTORIES[indexer.type];
    if (!factory) {
      throw new Error(`Unknown indexer type: ${indexer.type}`);
    }

    // Resolve effective proxy URL: only pass when indexer has useProxy enabled
    // FlareSolverr takes precedence at the adapter level — we still pass proxyUrl,
    // and each adapter handles precedence internally
    const useProxy = settings.useProxy === true;
    const effectiveProxyUrl = useProxy ? proxyUrl : undefined;

    this.log.debug({ indexer: indexer.name, type: indexer.type, proxied: !!effectiveProxyUrl }, 'Creating indexer adapter');
    return factory(settings, indexer.name, effectiveProxyUrl);
  }

  clearAdapterCache(): void {
    this.adapters.clear();
  }

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<{ success: boolean; message?: string; ip?: string; warning?: string; metadata?: Record<string, unknown> }> {
    try {
      this.log.debug({ type: data.type, hostname: data.settings.hostname, pageLimit: data.settings.pageLimit }, 'Testing indexer config');

      // When editing an existing indexer, resolve sentinel values against saved settings
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Indexer not found' };
        }
        resolvedSettings = { ...data.settings };
        resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>);
      }

      const proxyUrl = await this.getProxyUrl();
      const fakeRow = { id: 0, name: '', type: data.type, enabled: true, priority: 0, settings: resolvedSettings, createdAt: new Date() } as IndexerRow;
      const adapter = this.createAdapter(fakeRow, proxyUrl);
      const result = await adapter.test();
      this.log.debug({ type: data.type, success: result.success, message: result.message }, 'Indexer config test result');
      return result;
    } catch (error: unknown) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string; ip?: string; warning?: string; metadata?: Record<string, unknown> }> {
    const indexer = await this.getById(id);
    if (!indexer) {
      return { success: false, message: 'Indexer not found' };
    }

    try {
      const adapter = await this.getAdapter(indexer);
      const result = await adapter.test();
      this.log.debug({ id, success: result.success }, 'Indexer test result');

      // Persist VIP/class metadata from MAM adapter on successful test
      if (result.success && result.metadata && 'isVip' in result.metadata) {
        try {
          const existingSettings = (indexer.settings ?? {}) as Record<string, unknown>;
          const updates: Record<string, unknown> = { isVip: result.metadata.isVip };
          if ('classname' in result.metadata) {
            updates.classname = result.metadata.classname;
          }
          await this.update(id, { settings: { ...existingSettings, ...updates } });
          this.log.info({ id, isVip: result.metadata.isVip, classname: result.metadata.classname }, 'Persisted VIP/class status from test');
        } catch (error: unknown) {
          this.log.warn({ id, error }, 'Failed to persist VIP metadata after test');
        }
      }

      return result;
    } catch (error: unknown) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Pre-search status refresh for adapters that support it (e.g., MAM).
   * Returns { skip: true, error } if the indexer should be skipped (Mouse class).
   */
  private async preSearchRefresh(
    adapter: IndexerAdapter,
    indexer: IndexerRow,
  ): Promise<{ skip: boolean; error?: string }> {
    if (!adapter.refreshStatus) {
      return { skip: false };
    }

    let status: { isVip: boolean; classname: string } | null;
    try {
      status = await adapter.refreshStatus();
    } catch (error: unknown) {
      this.log.debug({ indexer: indexer.name, err: error }, 'Pre-search status refresh failed, proceeding with stored status');
      return { skip: false };
    }

    if (!status) {
      return { skip: false };
    }

    // Mouse class — block search
    if (status.classname === 'Mouse') {
      try {
        const existingSettings = (indexer.settings ?? {}) as Record<string, unknown>;
        await this.update(indexer.id, { settings: { ...existingSettings, isVip: status.isVip, classname: status.classname } });
        this.log.info({ id: indexer.id, classname: status.classname }, 'Persisted Mouse status from pre-search refresh');
      } catch (error: unknown) {
        this.log.warn({ id: indexer.id, error }, 'Failed to persist status from pre-search refresh');
      }
      return { skip: true, error: 'Searches disabled — Mouse class' };
    }

    // Class changed — persist updated status
    const existingSettings = (indexer.settings ?? {}) as Record<string, unknown>;
    if (existingSettings.isVip !== status.isVip || existingSettings.classname !== status.classname) {
      try {
        await this.update(indexer.id, { settings: { ...existingSettings, isVip: status.isVip, classname: status.classname } });
        this.log.info({ id: indexer.id, isVip: status.isVip, classname: status.classname }, 'Persisted class change from pre-search refresh');
      } catch (error: unknown) {
        this.log.warn({ id: indexer.id, error }, 'Failed to persist class change from pre-search refresh');
      }
    }

    return { skip: false };
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
    return all.filter((i) => IndexerService.RSS_CAPABLE_TYPES.includes(i.type));
  }

  /** Poll a single indexer with empty query (RSS feed). Returns results with parsed release names. */
  async pollRss(indexer: IndexerRow): Promise<SearchResult[]> {
    const adapter = await this.getAdapter(indexer);
    const raw = await adapter.search('');
    const results = raw.map(r => ({ ...r, indexerId: indexer.id }));
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

  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const enabledIndexers = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);

    this.log.debug({ query, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Searching enabled indexers');

    const settlements = await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        const adapter = await this.getAdapter(indexer);

        const refresh = await this.preSearchRefresh(adapter, indexer);
        if (refresh.skip) {
          this.log.warn({ indexer: indexer.name, error: refresh.error }, 'Indexer skipped by pre-search refresh');
          throw new Error(refresh.error ?? 'Indexer skipped');
        }

        const indexerResults = await adapter.search(query, options);
        this.log.debug({ indexer: indexer.name, resultCount: indexerResults.length, elapsedMs: Date.now() - indexerStartMs }, 'Indexer search completed');
        const mapped = indexerResults.map(r => ({ ...r, indexerId: indexer.id }));
        this.parseReleaseNames(mapped, indexer.name);
        return mapped;
      }),
    );

    const results: SearchResult[] = [];
    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i];
      if (settlement.status === 'fulfilled') {
        results.push(...settlement.value);
      } else {
        this.log.warn({ indexer: enabledIndexers[i].name, query, err: settlement.reason }, 'Error searching indexer');
      }
    }

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
    const enabledIndexers = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);

    this.log.debug({ query, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Streaming search started');

    const perIndexerResults = new Map<number, SearchResult[]>();

    await Promise.allSettled(
      enabledIndexers.map(async (indexer) => {
        const indexerStartMs = Date.now();
        const controller = controllers.get(indexer.id);
        const signal = controller?.signal;

        try {
          const adapter = await this.getAdapter(indexer);

          const refresh = await this.preSearchRefresh(adapter, indexer);
          if (refresh.skip) {
            const elapsedMs = Date.now() - indexerStartMs;
            callbacks.onError(indexer.id, indexer.name, refresh.error ?? 'Indexer skipped', elapsedMs);
            return;
          }

          const indexerResults = await adapter.search(query, { ...options, signal });
          const elapsedMs = Date.now() - indexerStartMs;
          const mapped = indexerResults.map(r => ({ ...r, indexerId: indexer.id }));
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
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.log.warn({ indexer: indexer.name, query, err: error }, 'Error searching indexer');
          callbacks.onError(indexer.id, indexer.name, message, elapsedMs);
        }
      }),
    );

    // Aggregate results from non-cancelled indexers
    const results: SearchResult[] = [];
    for (const indexerResults of perIndexerResults.values()) {
      results.push(...indexerResults);
    }

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
