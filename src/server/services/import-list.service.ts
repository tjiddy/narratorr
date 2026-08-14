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
import { serializeError } from '../utils/serialize-error.js';
import type { BookService } from './book.service.js';
import type { ImportListExclusionService } from './import-list-exclusion.service.js';
import { addBook, type AddBookDeps, type AddBookEvent } from './book-intake/index.js';
import type { ImportListType } from '@shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '@shared/schemas/import-list.js';
import type { ImportListRow } from './types.js';
import type { ImmediateSearchBook, ImmediateSearchDeps } from './trigger-immediate-search.js';
import { runImmediateSearchChain } from './immediate-search-chain.js';

const MS_PER_MINUTE = 60_000;

type NewImportList = typeof importLists.$inferInsert;

/** Per-item result used to report created versus review-held versus excluded counts (#1735, #2305). */
type ItemOutcome = 'created' | 'held_review' | 'skipped' | 'excluded';

/** A created book carries the payload its search will key on; every other outcome carries none. */
interface ItemResult {
  outcome: ItemOutcome;
  search?: ImmediateSearchBook;
}

interface SyncCounts {
  createdCount: number;
  heldReviewCount: number;
  /** Items the operator already deleted once; disjoint from the other two counters. */
  excludedCount: number;
}

/** What one list's sync did. A `failed` sync has already recorded `lastSyncError` (#2306). */
export type SyncOutcome =
  | { status: 'ok'; counts: SyncCounts }
  | { status: 'failed'; message: string };

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
    private exclusions?: ImportListExclusionService,
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
      // The outcome is the manual path's return value; here the failure is already logged inside.
      await this.syncAndRecord(list, now);
    }
  }

  /**
   * Run one list to completion and be the sole writer of its `lastRunAt` / `nextRunAt` /
   * `lastSyncError` bookkeeping — a second copy in either caller is how the scheduled and manual
   * paths would drift (#2306 AC2). `now` is passed in because `syncDueLists` captures one for the
   * whole cycle while `nextRunAt` is computed at completion; that mixed pair is preserved as-is.
   */
  private async syncAndRecord(list: ImportListRow, now: Date): Promise<SyncOutcome> {
    try {
      const counts = await this.syncList(list);
      // A run — scheduled or manual — always puts the next automatic run one full interval out.
      // Preserving a manual run's prior `nextRunAt` would leave it in the past, so the cron would
      // re-sync the same list against the same provider minutes later (#2304's load pattern).
      const nextRunAt = new Date(Date.now() + list.syncIntervalMinutes * MS_PER_MINUTE);
      await this.db
        .update(importLists)
        .set({ lastRunAt: now, nextRunAt, lastSyncError: null })
        .where(eq(importLists.id, list.id));
      this.log.info(
        {
          id: list.id,
          name: list.name,
          createdCount: counts.createdCount,
          heldReviewCount: counts.heldReviewCount,
          excludedCount: counts.excludedCount,
        },
        'Import list sync completed',
      );
      return { status: 'ok', counts };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      const nextRunAt = new Date(Date.now() + list.syncIntervalMinutes * MS_PER_MINUTE);
      await this.db
        .update(importLists)
        .set({ lastSyncError: message, nextRunAt })
        .where(eq(importLists.id, list.id));
      // `message` is what the row and the manual response carry; the log keeps the caught value's
      // stack, type and cause, which a manual failure is the only interactive way to see.
      this.log.error({ id: list.id, name: list.name, error: serializeError(error) }, 'Import list sync failed');
      return { status: 'failed', message };
    }
  }

  /**
   * Operator-triggered sync of one list, admitted by the caller's `import-list-sync` task guard.
   * Deliberately reads neither `enabled` nor `nextRunAt`: those govern *automatic* scheduling
   * (`syncDueLists`' where clause), so a disabled list can be run once to check it and stays
   * disabled — the advanced `nextRunAt` has no effect until the operator re-enables it.
   */
  async runNow(id: number): Promise<SyncOutcome | null> {
    // Raw row, not `getById`: `syncAndRecord` takes one input shape and `syncList` decrypts itself.
    const results = await this.db.select().from(importLists).where(eq(importLists.id, id)).limit(1);
    const list = results[0];
    if (!list) return null;
    return this.syncAndRecord(list, new Date());
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

    const counts: SyncCounts = { createdCount: 0, heldReviewCount: 0, excludedCount: 0 };
    const pendingSearches: ImmediateSearchBook[] = [];
    for (const item of items) {
      if (!item.title?.trim()) {
        this.log.warn({ listId: list.id, item }, 'Skipping item with empty/null title');
        continue;
      }

      try {
        const result = await this.processItem(item, list);
        if (result.outcome === 'created') {
          counts.createdCount++;
          if (result.search) pendingSearches.push(result.search);
        } else if (result.outcome === 'held_review') counts.heldReviewCount++;
        else if (result.outcome === 'excluded') counts.excludedCount++;
      } catch (error: unknown) {
        this.log.warn({ listId: list.id, title: item.title, error: serializeError(error) }, 'Failed to process import list item');
      }
    }

    if (this.searchDeps && qualitySettings?.searchImmediately) {
      // Awaited, unlike the other batch caller: `TaskRegistry.executeTracked` holds `running`
      // across this callback, so awaiting is what keeps the `import-list-sync` cron guard honest
      // for the cycle the searches belong to — no admission state of its own is needed.
      await runImmediateSearchChain(pendingSearches, this.searchDeps, this.log);
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
      // The only surface that gates on exclusions: a list re-adding a deleted book is the loop the
      // exclusion exists to break, and no manual add has one.
      exclusions: this.exclusions,
    };
  }

  private async processItem(item: ImportListItem, list: ImportListRow): Promise<ItemResult> {
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

    if (result.outcome === 'excluded') return { outcome: 'excluded' };
    if (result.outcome === 'owned-race') return { outcome: 'skipped' };
    if (result.outcome === 'duplicate') return { outcome: result.verdict === 'review' ? 'held_review' : 'skipped' };

    const created = result.book;
    this.log.info({ bookId: created.id, title: created.title, listName: list.name }, 'Book added from import list');

    return {
      outcome: 'created',
      // The row's resolved primary author, not the hydrated list, is what the search query keys on.
      search: { ...created, authors: result.authorName ? [{ name: result.authorName }] : [] },
    };
  }
}
