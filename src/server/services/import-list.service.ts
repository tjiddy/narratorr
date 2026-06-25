import { eq, and, lte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importLists, bookEvents } from '../../db/schema.js';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '../../core/import-lists/index.js';
import type { ImportListItem } from '../../core/import-lists/index.js';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/types.js';
import { RateLimitError, TransientError } from '../../core/index.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { BookService } from './book.service.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '../../shared/schemas/import-list.js';
import type { ImportListRow } from './types.js';
import { triggerImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { AppSettings } from '../../shared/schemas.js';

type QualitySettings = AppSettings['quality'];

/** Milliseconds per minute — used for sync interval calculations. */
const MS_PER_MINUTE = 60_000;

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
      nextRunAt: new Date(), // Sync on next poller cycle
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
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(importLists).where(eq(importLists.id, id)).limit(1);
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('importList'));
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

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<{ success: boolean; message?: string | undefined }> {
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
        resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('importList'));
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

    const qualitySettings = this.searchDeps ? await this.searchDeps.settingsService.get('quality') : undefined;

    for (const item of items) {
      if (!item.title?.trim()) {
        this.log.warn({ listId: list.id, item }, 'Skipping item with empty/null title');
        continue;
      }

      try {
        await this.processItem(item, list, qualitySettings);
      } catch (error: unknown) {
        this.log.warn({ listId: list.id, title: item.title, error: getErrorMessage(error) }, 'Failed to process import list item');
      }
    }
  }

  /**
   * Resolve the rich metadata for an import-list item via the shared
   * {@link MetadataService.resolveBook} resolver (ASIN fast path → title/author
   * search fallback + validation), then build the enriched payload.
   *
   * The resolver carries the **correct audiobook ASIN** it found, so a bad
   * print/Kindle provider ASIN is transparently replaced by the audiobook ASIN
   * the search recovers (see {@link buildMatchedEnriched}). Returns the
   * intermediate payload plus the `enrichmentStatus` to persist:
   * - match adopted → `undefined` (default `'pending'`; rich metadata flows).
   * - genuine no-match → `'failed'` (book still created so the import isn't
   *   dropped; the background job retries it via search after 1h).
   * - rate limit / transient error / no metadata service → `undefined`
   *   (`'pending'`; raw provider fields, resolvable later — a rate limit is NOT
   *   a no-match).
   */
  private async enrichItem(item: ImportListItem): Promise<{ enriched: EnrichedItem; enrichmentStatus: 'failed' | undefined }> {
    const { match, enrichmentStatus } = await this.resolveMatch(item);
    return { enriched: buildEnrichedItem(item, match), enrichmentStatus };
  }

  private async resolveMatch(item: ImportListItem): Promise<{ match: BookMetadata | null; enrichmentStatus: 'failed' | undefined }> {
    if (!this.metadata) return { match: null, enrichmentStatus: undefined };
    try {
      const match = await this.metadata.resolveBook({
        asin: item.asin,
        title: item.title,
        author: item.author,
      });
      if (match) {
        this.logIdentityMismatch(item, match);
        return { match, enrichmentStatus: undefined };
      }
      // Genuine no-match: still create the book (don't silently drop the import)
      // but mark it failed so the background job retries via search after 1h.
      return { match: null, enrichmentStatus: 'failed' };
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        // Transient provider state, NOT a no-match — leave the book resolvable
        // later (pending), do not mark it failed.
        this.log.warn({ title: item.title, provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Metadata resolution rate limited; leaving book pending');
        return { match: null, enrichmentStatus: undefined };
      }
      if (error instanceof TransientError) {
        // Transient provider failure (timeout / 5xx / malformed JSON) during the
        // fallback search — NOT a no-match. Leave the book pending so the
        // background job retries it, same as the rate-limit branch above.
        this.log.warn({ title: item.title, provider: error.provider }, 'Metadata resolution hit a transient provider error; leaving book pending');
        return { match: null, enrichmentStatus: undefined };
      }
      this.log.warn({ title: item.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
      return { match: null, enrichmentStatus: undefined };
    }
  }

  /**
   * Emit a warn audit log when ASIN-resolved metadata disagrees with the raw
   * provider title/author. The metadata is still adopted (ASIN is identity);
   * the log lets operators trace mixed-identity book rows back to their
   * source. Skipped when the raw fields are absent or already agree.
   */
  private logIdentityMismatch(item: ImportListItem, match: BookMetadata): void {
    const metadataAuthor = match.authors[0]?.name;
    const titleDiffers = !!item.title && item.title !== match.title;
    const authorDiffers = !!item.author && !!metadataAuthor && item.author !== metadataAuthor;
    if (!titleDiffers && !authorDiffers) return;
    this.log.warn(
      {
        asin: match.asin ?? item.asin,
        listTitle: item.title,
        metadataTitle: match.title,
        listAuthor: item.author,
        metadataAuthor,
      },
      'Import-list ASIN identity disagrees with raw item fields; adopting metadata',
    );
  }

  private async processItem(item: ImportListItem, list: ImportListRow, qualitySettings?: QualitySettings): Promise<void> {
    const { enriched, enrichmentStatus } = await this.enrichItem(item);

    const authorList = enriched.authorName ? [{ name: enriched.authorName }] : undefined;
    const duplicate = await this.bookService.findDuplicate(enriched.title, authorList, enriched.asin);
    if (duplicate) {
      this.log.debug({ title: enriched.title, asin: enriched.asin }, 'Book already exists, skipped');
      return;
    }

    const created = await this.bookService.create({
      title: enriched.title,
      authors: enriched.authorName ? [{ name: enriched.authorName }] : [],
      narrators: enriched.narrators,
      subtitle: enriched.subtitle,
      description: enriched.description,
      publisher: enriched.publisher,
      coverUrl: enriched.coverUrl,
      asin: enriched.asin,
      isbn: enriched.isbn,
      seriesName: enriched.seriesName,
      seriesPosition: enriched.seriesPosition,
      seriesAsin: enriched.seriesAsin,
      duration: enriched.duration,
      publishedDate: enriched.publishedDate,
      genres: enriched.genres,
      status: 'wanted',
      enrichmentStatus,
      importListId: list.id,
    });

    await this.db.insert(bookEvents).values({
      bookId: created.id,
      bookTitle: created.title,
      authorName: enriched.authorName ?? null,
      eventType: 'book_added',
      source: 'import_list',
      reason: { importListName: list.name },
    });

    this.log.info({ bookId: created.id, title: created.title, listName: list.name }, 'Book added from import list');

    if (this.searchDeps && qualitySettings?.searchImmediately) {
      const bookForSearch = {
        ...created,
        authors: enriched.authorName ? [{ name: enriched.authorName }] : [],
      };
      triggerImmediateSearch(bookForSearch, this.searchDeps, this.log);
    }
  }
}

/**
 * Build the intermediate enriched payload from `(item, match)`.
 *
 * - `match` present — metadata wins for `title` and `authorName` (the resolved
 *   record is canonical identity). `BookMetadataSchema` requires `title` and a
 *   non-empty `authors`, so no per-field fallback is needed. Provider-first
 *   still applies to cover/description/isbn (raw item value is a hint), but the
 *   resolved **audiobook ASIN wins** over the raw provider ASIN (which may be a
 *   print/Kindle ASIN). `seriesPrimary` wins over `series[0]` (#1088 / #1097).
 * - `match` null — raw item fields only; no metadata side fields populated.
 *
 * Lives outside the class so its many `??`/`?.` operators don't accumulate
 * cyclomatic complexity in `enrichItem`.
 */
function buildEnrichedItem(item: ImportListItem, match: BookMetadata | null): EnrichedItem {
  if (!match) return buildRawEnriched(item);
  return buildMatchedEnriched(item, match);
}

function buildRawEnriched(item: ImportListItem): EnrichedItem {
  return {
    title: item.title,
    authorName: item.author,
    coverUrl: item.coverUrl,
    description: item.description,
    asin: item.asin,
    isbn: item.isbn,
  };
}

function buildMatchedEnriched(item: ImportListItem, match: BookMetadata): EnrichedItem {
  const primarySeries = match.seriesPrimary ?? match.series?.[0];
  return {
    title: match.title,
    authorName: match.authors[0]?.name,
    coverUrl: item.coverUrl ?? match.coverUrl,
    subtitle: match.subtitle,
    description: item.description ?? match.description,
    publisher: match.publisher,
    seriesName: primarySeries?.name,
    seriesPosition: primarySeries?.position,
    seriesAsin: primarySeries?.asin,
    narrators: match.narrators,
    duration: match.duration,
    publishedDate: match.publishedDate,
    genres: match.genres,
    // Resolved audiobook ASIN wins: when the search fallback recovered the real
    // audiobook, `match.asin` is the correct ASIN to persist — NOT the raw
    // provider ASIN (which may be a print/Kindle ASIN that 404s on Audnexus).
    // On the ASIN fast path `match.asin` echoes `item.asin`, so this is a no-op.
    asin: match.asin ?? item.asin,
    isbn: item.isbn ?? match.isbn,
  };
}

/** Intermediate enriched payload — `title` is canonical (metadata title on a
 *  successful match, raw item title otherwise), and `authorName` is singular,
 *  translated to `authors: { name: string }[]` at the
 *  {@link BookService.create} call site. */
interface EnrichedItem {
  title: string;
  coverUrl?: string | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  seriesAsin?: string | undefined;
  narrators?: string[] | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  authorName?: string | undefined;
}
