import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import { indexers } from '@narratorr/db/schema';
import {
  AudioBookBayIndexer,
  type IndexerAdapter,
  type SearchResult,
  type SearchOptions,
  type ABBConfig,
} from '@narratorr/core';

type IndexerRow = typeof indexers.$inferSelect;
type NewIndexer = typeof indexers.$inferInsert;

export class IndexerService {
  private adapters: Map<number, IndexerAdapter> = new Map();

  constructor(private db: Db) {}

  async getAll(): Promise<IndexerRow[]> {
    return this.db.select().from(indexers).orderBy(indexers.priority);
  }

  async getById(id: number): Promise<IndexerRow | null> {
    const results = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewIndexer, 'id' | 'createdAt'>): Promise<IndexerRow> {
    const result = await this.db.insert(indexers).values(data).returning();
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

    return result[0] || null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(indexers).where(eq(indexers.id, id));
    this.adapters.delete(id);
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
        return new AudioBookBayIndexer(config);
      }
      default:
        throw new Error(`Unknown indexer type: ${indexer.type}`);
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
    const indexer = await this.getById(id);
    if (!indexer) {
      return { success: false, message: 'Indexer not found' };
    }

    try {
      const adapter = await this.getAdapter(indexer);
      return adapter.test();
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const enabledIndexers = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.enabled, true))
      .orderBy(indexers.priority);

    const results: SearchResult[] = [];

    for (const indexer of enabledIndexers) {
      try {
        const adapter = await this.getAdapter(indexer);
        const indexerResults = await adapter.search(query, options);
        results.push(...indexerResults);
      } catch (error) {
        console.error(`Error searching indexer ${indexer.name}:`, error);
      }
    }

    return results;
  }
}
