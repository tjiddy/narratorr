import { eq, and, lte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importLists, books, bookEvents, bookAuthors } from '../../db/schema.js';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '../../core/import-lists/index.js';
import type { ImportListItem } from '../../core/import-lists/index.js';
import type { MetadataService } from './metadata.service.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';
import { findOrCreateAuthor } from '../utils/find-or-create-person.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '../../shared/schemas/import-list.js';

/** Milliseconds per minute — used for sync interval calculations. */
const MS_PER_MINUTE = 60_000;

type ImportListRow = typeof importLists.$inferSelect;
type NewImportList = typeof importLists.$inferInsert;

/**
 * Parse a saved settings JSON blob through the per-type Zod schema.
 *
 * Normalizes legacy blank values that pre-date the type tightening (e.g. Hardcover
 * `shelfId: ''` from the old default) so existing rows continue to work after upgrade.
 */
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
    private metadata?: MetadataService,
  ) {}

  private decryptRow(row: ImportListRow): ImportListRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('importList', s, getKey()) };
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
      nextRunAt: new Date(), // Sync on next poller cycle
    };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('importList', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(importLists).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Import list created');
    return this.decryptRow(result[0]);
  }

  async update(id: number, data: Partial<NewImportList>): Promise<ImportListRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(importLists).where(eq(importLists.id, id)).limit(1);
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>);
      toUpdate.settings = encryptFields('importList', settings, getKey());
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

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<{ success: boolean; message?: string }> {
    try {
      const factory = IMPORT_LIST_ADAPTER_FACTORIES[data.type as keyof typeof IMPORT_LIST_ADAPTER_FACTORIES];
      if (!factory) return { success: false, message: `Unknown provider type: ${data.type}` };

      // When editing an existing list, resolve sentinel values against saved settings
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Import list not found' };
        }
        resolvedSettings = { ...data.settings };
        resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>);
      }

      const parsed = parseSettingsForType(data.type, resolvedSettings);
      const provider = factory(parsed);
      return await provider.test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
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
        await this.syncList(list);
        const nextRunAt = new Date(Date.now() + list.syncIntervalMinutes * MS_PER_MINUTE);
        await this.db
          .update(importLists)
          .set({ lastRunAt: now, nextRunAt, lastSyncError: null })
          .where(eq(importLists.id, list.id));
        this.log.info({ id: list.id, name: list.name }, 'Import list sync completed');
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

  private async syncList(list: ImportListRow): Promise<void> {
    const decrypted = this.decryptRow(list);
    const factory = IMPORT_LIST_ADAPTER_FACTORIES[decrypted.type as keyof typeof IMPORT_LIST_ADAPTER_FACTORIES];
    if (!factory) throw new Error(`Unknown provider type: ${decrypted.type}`);

    const parsed = parseSettingsForType(decrypted.type, decrypted.settings as Record<string, unknown>);
    const provider = factory(parsed);
    const items = await provider.fetchItems();

    this.log.info({ id: list.id, name: list.name, itemCount: items.length }, 'Fetched items from provider');

    for (const item of items) {
      if (!item.title?.trim()) {
        this.log.warn({ listId: list.id, item }, 'Skipping item with empty/null title');
        continue;
      }

      try {
        await this.processItem(item, list);
      } catch (error: unknown) {
        this.log.warn({ listId: list.id, title: item.title, error: getErrorMessage(error) }, 'Failed to process import list item');
      }
    }
  }

  private async enrichItem(item: ImportListItem): Promise<{ asin?: string; author?: string }> {
    if (!this.metadata || item.asin) return { asin: item.asin, author: item.author };
    try {
      const query = item.author ? `${item.title} ${item.author}` : item.title;
      const searchResults = await this.metadata.search(query);
      if (searchResults.books.length === 0) return { asin: item.asin, author: item.author };
      const match = searchResults.books[0];
      let asin = match.asin;
      // Follow providerId to detail endpoint for ASIN if search result didn't include one
      if (!asin && match.providerId) {
        const detail = await this.metadata.getBook(match.providerId);
        if (detail?.asin) asin = detail.asin;
      }
      return {
        asin: asin || item.asin,
        author: item.author || match.authors?.[0]?.name,
      };
    } catch (error: unknown) {
      this.log.warn({ title: item.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
      return { asin: item.asin, author: item.author };
    }
  }

  private async processItem(item: ImportListItem, list: ImportListRow): Promise<void> {
    const enriched = await this.enrichItem(item);

    const insertResult = await this.db
      .insert(books)
      .values({
        title: item.title,
        asin: enriched.asin || null,
        isbn: item.isbn || null,
        status: 'wanted',
        enrichmentStatus: 'pending',
        importListId: list.id,
        monitorForUpgrades: false,
      })
      .onConflictDoNothing()
      .returning();

    if (insertResult.length === 0) {
      this.log.debug({ title: item.title, asin: enriched.asin }, 'Book already exists, skipped');
      return;
    }

    const newBook = insertResult[0];

    // Insert author junction row if author is known
    if (enriched.author) {
      let authorId: number | undefined;
      try {
        authorId = await findOrCreateAuthor(this.db, enriched.author);
      } catch (_error: unknown) {
        this.log.warn({ title: newBook.title, author: enriched.author }, 'Author resolution failed, skipping bookAuthors');
      }
      if (authorId !== undefined) {
        await this.db.insert(bookAuthors).values({ bookId: newBook.id, authorId, position: 0 });
      }
    }

    await this.db.insert(bookEvents).values({
      bookId: newBook.id,
      bookTitle: newBook.title,
      authorName: enriched.author || null,
      eventType: 'grabbed',
      source: 'import_list',
    });

    this.log.info({ bookId: newBook.id, title: newBook.title, listName: list.name }, 'Book added from import list');
  }
}
