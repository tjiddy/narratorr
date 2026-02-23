import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '@narratorr/db/schema';
import {
  AudioBookBayIndexer,
  NewznabIndexer,
  TorznabIndexer,
  parseAudiobookTitle,
  scoreResult,
  type IndexerAdapter,
  type SearchResult,
  type SearchOptions,
  type ABBConfig,
  type NewznabConfig,
  type TorznabConfig,
} from '@narratorr/core';

type IndexerRow = typeof indexers.$inferSelect;
type NewIndexer = typeof indexers.$inferInsert;

export class IndexerService {
  private adapters: Map<number, IndexerAdapter> = new Map();

  constructor(private db: Db, private log: FastifyBaseLogger) {}

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

  async getAdapter(indexer: IndexerRow): Promise<IndexerAdapter> {
    let adapter = this.adapters.get(indexer.id);

    if (!adapter) {
      adapter = this.createAdapter(indexer);
      this.adapters.set(indexer.id, adapter);
    }

    return adapter;
  }

  private createAdapter(indexer: IndexerRow): IndexerAdapter {
    const settings = indexer.settings as Record<string, unknown>;

    switch (indexer.type) {
      case 'abb': {
        const config: ABBConfig = {
          hostname: (settings.hostname as string) || 'audiobookbay.lu',
          pageLimit: (settings.pageLimit as number) || 2,
        };
        this.log.debug({ indexer: indexer.name, type: indexer.type, hostname: config.hostname, pageLimit: config.pageLimit }, 'Creating indexer adapter');
        return new AudioBookBayIndexer(config);
      }
      case 'newznab': {
        const config: NewznabConfig = {
          apiUrl: settings.apiUrl as string,
          apiKey: settings.apiKey as string,
        };
        this.log.debug({ indexer: indexer.name, type: indexer.type, apiUrl: config.apiUrl }, 'Creating indexer adapter');
        return new NewznabIndexer(config, indexer.name);
      }
      case 'torznab': {
        const config: TorznabConfig = {
          apiUrl: settings.apiUrl as string,
          apiKey: settings.apiKey as string,
        };
        this.log.debug({ indexer: indexer.name, type: indexer.type, apiUrl: config.apiUrl }, 'Creating indexer adapter');
        return new TorznabIndexer(config, indexer.name);
      }
      default:
        throw new Error(`Unknown indexer type: ${indexer.type}`);
    }
  }

  async testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string }> {
    try {
      this.log.debug({ type: data.type, hostname: data.settings.hostname, pageLimit: data.settings.pageLimit }, 'Testing indexer config');
      const fakeRow = { id: 0, name: '', type: data.type, enabled: true, priority: 0, settings: data.settings, createdAt: new Date() } as IndexerRow;
      const adapter = this.createAdapter(fakeRow);
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

  async test(id: number): Promise<{ success: boolean; message?: string }> {
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
