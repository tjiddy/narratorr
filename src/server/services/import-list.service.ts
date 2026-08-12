import { eq, and, lte } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importLists, bookEvents } from '@db/schema.js';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '@core/import-lists/index.js';
import type { ImportListItem } from '@core/import-lists/index.js';
import type { MetadataService } from './metadata.service.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings, resolveSettings } from '../utils/sentinel-resolver.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { BookService } from './book.service.js';
import { addBook, type AddBookDeps, type AddBookEvent } from './book-intake/index.js';
import type { ImportListType } from '@shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '@shared/schemas/import-list.js';
import type { ImportListRow } from './types.js';
import { triggerImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { AppSettings } from '@shared/schemas.js';

type QualitySettings = AppSettings['quality'];

const MS_PER_MINUTE = 60_000;

type NewImportList = typeof importLists.$inferInsert;

/** Per-item result used to report created versus review-held counts (#1735). */
type ItemOutcome = 'created' | 'held_review' | 'skipped';

interface SyncCounts {
  createdCount: number;
  heldReviewCount: number;
}

/** Normalize legacy Hardcover `shelfId: ''` before strict per-provider schema parsing. */
function parseSettingsForType(type: string, settings: Record<string, unknown>): ImportListSettings {
  const schema = importListSettingsSchemas[type as ImportListType];
  if (!schema) throw new Error(`Unknown provider type: ${type}`);
  const normalized = { ...settings };
  if (type === 'hardcover' && normalized.shelfId === '') delete normalized.shelfId;
  return schema.parse(normalized) as ImportListSettings;
}

export class ImportListService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private bookService: BookService,
    private metadata?: MetadataService,
    private searchDeps?: ImmediateSearchDeps,
  ) {}

  private decryptRow(row: ImportListRow): ImportListRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('importList', s, getKey(), this.log) };
  }

  async getAll(): Promise<ImportListRow[]> {
    const rows = await this.db.select().from(importLists).orderBy(importLists.name);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<ImportListRow | null> {
    const results = await this.db.select().from(importLists).where(eq(importLists.id, id)).limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async create(data: Omit<NewImportList, 'id' | 'createdAt'>): Promise<ImportListRow> {
    const toInsert = {
      ...data,
      nextRunAt: new Date(),
    };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('importList', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(importLists).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Import list created');
    return this.decryptRow(result[0]!);
  }

  async update(id: number, data: Partial<NewImportList>): Promise<ImportListRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const existing = await this.db.select().from(importLists).where(eq(importLists.id, id)).limit(1);
      toUpdate.settings = resolveAndEncryptSettings('importList', toUpdate.settings as Record<string, unknown>, existing[0]?.settings as Record<string, unknown> | undefined);
    }
    const result = await this.db
      .update(importLists)
      .set(toUpdate)
      .where(eq(importLists.id, id))
      .returning();
    this.log.info({ id }, 'Import list updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;
    await this.db.delete(importLists).where(eq(importLists.id, id));
    this.log.info({ id }, 'Import list deleted');
    return true;
  }

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<{ success: boolean; message?: string | undefined }> {
    try {
      const factory = IMPORT_LIST_ADAPTER_FACTORIES[data.type as keyof typeof IMPORT_LIST_ADAPTER_FACTORIES];
      if (!factory) return { success: false, message: `Unknown provider type: ${data.type}` };

      // Resolve edited sentinel values against stored secrets before testing.
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Import list not found' };
        }
        resolvedSettings = resolveSettings('importList', data.settings, existing.settings as Record<string, unknown> | undefined);
      }

      const parsed = parseSettingsForType(data.type, resolvedSettings);
      const provider = factory(parsed);
      return await provider.test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string | undefined }> {
    const list = await this.getById(id);
    if (!list) return { success: false, message: 'Import list not found' };
    return this.testConfig({ type: list.type, settings: list.settings as Record<string, unknown> });
  }

  async preview(data: { type: string; settings: Record<string, unknown> }): Promise<{ items: ImportListItem[]; total: number }> {
    const factory = IMPORT_LIST_ADAPTER_FACTORIES[data.type as keyof typeof IMPORT_LIST_ADAPTER_FACTORIES];
    if (!factory) throw new Error(`Unknown provider type: ${data.type}`);
    const parsed = parseSettingsForType(data.type, data.settings);
    const provider = factory(parsed);
    const allItems = await provider.fetchItems();
    return { items: allItems.slice(0, 10), total: allItems.length };
  }

  async syncDueLists(): Promise<void> {
    const now = new Date();
    const dueLists = await this.db
      .select()
      .from(importLists)
      .where(and(eq(importLists.enabled, true), lte(importLists.nextRunAt, now)));

    if (dueLists.length === 0) return;

    this.log.info({ count: dueLists.length }, 'Processing due import lists');

    for (const list of dueLists) {
      try {
        const counts = await this.syncList(list);
        const nextRunAt = new Date(Date.now() + list.syncIntervalMinutes * MS_PER_MINUTE);
        await this.db
          .update(importLists)
          .set({ lastRunAt: now, nextRunAt, lastSyncError: null })
          .where(eq(importLists.id, list.id));
        this.log.info(
          { id: list.id, name: list.name, createdCount: counts.createdCount, heldReviewCount: counts.heldReviewCount },
          'Import list sync completed',
        );
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        const nextRunAt = new Date(Date.now() + list.syncIntervalMinutes * MS_PER_MINUTE);
        await this.db
          .update(importLists)
          .set({ lastSyncError: message, nextRunAt })
          .where(eq(importLists.id, list.id));
        this.log.error({ id: list.id, name: list.name, error: message }, 'Import list sync failed');
      }
    }
  }

  private async syncList(list: ImportListRow): Promise<SyncCounts> {
    const decrypted = this.decryptRow(list);
    const factory = IMPORT_LIST_ADAPTER_FACTORIES[decrypted.type as keyof typeof IMPORT_LIST_ADAPTER_FACTORIES];
    if (!factory) throw new Error(`Unknown provider type: ${decrypted.type}`);

    const parsed = parseSettingsForType(decrypted.type, decrypted.settings as Record<string, unknown>);
    const provider = factory(parsed);
    const items = await provider.fetchItems();

    this.log.info({ id: list.id, name: list.name, itemCount: items.length }, 'Fetched items from provider');

    const qualitySettings = this.searchDeps ? await this.searchDeps.settingsService.get('quality') : undefined;

    const counts: SyncCounts = { createdCount: 0, heldReviewCount: 0 };
    for (const item of items) {
      if (!item.title?.trim()) {
        this.log.warn({ listId: list.id, item }, 'Skipping item with empty/null title');
        continue;
      }

      try {
        const outcome = await this.processItem(item, list, qualitySettings);
        if (outcome === 'created') counts.createdCount++;
        else if (outcome === 'held_review') counts.heldReviewCount++;
      } catch (error: unknown) {
        this.log.warn({ listId: list.id, title: item.title, error: getErrorMessage(error) }, 'Failed to process import list item');
      }
    }
    return counts;
  }

  /**
   * The shared pipeline's dependencies. The event port is the raw insert this service has always
   * used, so injecting `EventHistoryService` — and rewriting every construction in its suite — is
   * not needed to share the pipeline.
   */
  private addDeps(): AddBookDeps {
    return {
      bookService: this.bookService,
      eventHistory: { create: (event: AddBookEvent) => Promise.resolve(this.db.insert(bookEvents).values(event)) },
      resolver: this.metadata,
    };
  }

  private async processItem(item: ImportListItem, list: ImportListRow, qualitySettings?: QualitySettings): Promise<ItemOutcome> {
    // A shelf item's title and author are user data, so the resolved match owns the row's identity.
    const result = await addBook(this.addDeps(), {
      resolve: 'required',
      seed: item,
      identity: 'adopt',
      onReview: 'record-and-hold',
      provenance: {
        source: 'import_list', reason: { importListName: list.name }, eventShape: 'resolved', importListId: list.id,
      },
    }, this.log);

    if (result.outcome === 'owned-race') return 'skipped';
    if (result.outcome === 'duplicate') return result.verdict === 'review' ? 'held_review' : 'skipped';

    const created = result.book;
    this.log.info({ bookId: created.id, title: created.title, listName: list.name }, 'Book added from import list');

    if (this.searchDeps && qualitySettings?.searchImmediately) {
      // The row's resolved primary author, not the hydrated list, is what the search query keys on.
      const bookForSearch = {
        ...created,
        authors: result.authorName ? [{ name: result.authorName }] : [],
      };
      triggerImmediateSearch(bookForSearch, this.searchDeps, this.log);
    }
    return 'created';
  }
}
