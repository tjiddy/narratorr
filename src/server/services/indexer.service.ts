import { eq } from 'drizzle-orm';
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

type IndexerRow = typeof indexers.$inferSelect;
type NewIndexer = typeof indexers.$inferInsert;

export class IndexerService {
  private adapters: Map<number, IndexerAdapter> = new Map();

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private settingsService?: SettingsService,
  ) {}

  async getAll(): Promise<IndexerRow[]> {
    return this.db.select().from(indexers).orderBy(indexers.priority);
  }

  async getById(id: number): Promise<IndexerRow | null> {
    const results = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewIndexer, 'id' | 'createdAt'>): Promise<IndexerRow> {
    const result = await this.db.insert(indexers).values(data).returning();
    this.log.info({ name: data.name, type: data.type }, 'Indexer created');
    return result[0];
  }

  async update(id: number, data: Partial<NewIndexer>): Promise<IndexerRow | null> {
    const result = await this.db
      .update(indexers)
      .set(data)
      .where(eq(indexers.id, id))
      .returning();

    // Clear cached adapter
    this.adapters.delete(id);

    this.log.info({ id }, 'Indexer updated');
    return result[0] || null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(indexers).where(eq(indexers.id, id));
    this.adapters.delete(id);
    this.log.info({ id }, 'Indexer deleted');
    return true;
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
      adapter = this.createAdapter(indexer, proxyUrl);
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

  async testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string; ip?: string }> {
    try {
      this.log.debug({ type: data.type, hostname: data.settings.hostname, pageLimit: data.settings.pageLimit }, 'Testing indexer config');
      const proxyUrl = await this.getProxyUrl();
      const fakeRow = { id: 0, name: '', type: data.type, enabled: true, priority: 0, settings: data.settings, createdAt: new Date() } as IndexerRow;
      const adapter = this.createAdapter(fakeRow, proxyUrl);
      const result = await adapter.test();
      this.log.debug({ type: data.type, success: result.success, message: result.message }, 'Indexer config test result');
      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string; ip?: string }> {
    const indexer = await this.getById(id);
    if (!indexer) {
      return { success: false, message: 'Indexer not found' };
    }

    try {
      const adapter = await this.getAdapter(indexer);
      const result = await adapter.test();
      this.log.debug({ id, success: result.success }, 'Indexer test result');
      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /** Parse release names to extract author/title for results that don't already have them */
  private parseReleaseNames(results: SearchResult[]): void {
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
        this.log.debug({ rawTitle: result.rawTitle ?? result.title }, 'Unparsed release name');
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
    const results = await adapter.search('');
    this.parseReleaseNames(results);
    return results;
  }

  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const enabledIndexers = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);

    this.log.debug({ query, indexers: enabledIndexers.map(i => i.name), count: enabledIndexers.length }, 'Searching enabled indexers');

    const results: SearchResult[] = [];

    for (const indexer of enabledIndexers) {
      try {
        const adapter = await this.getAdapter(indexer);
        const indexerResults = await adapter.search(query, options);
        this.log.debug({ indexer: indexer.name, results: indexerResults.length }, 'Indexer search completed');
        results.push(...indexerResults);
      } catch (error) {
        this.log.warn({ indexer: indexer.name, query, error }, 'Error searching indexer');
      }
    }

    this.parseReleaseNames(results);

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
}
