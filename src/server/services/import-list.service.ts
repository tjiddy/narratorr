import { eq, and, lte } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importLists, bookEvents } from '@db/schema.js';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '@core/import-lists/index.js';
import type { ImportListItem } from '@core/import-lists/index.js';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import type { ProductionType } from '@shared/schemas/book.js';
import { RateLimitError, TransientError } from '@core/index.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings, resolveSettings } from '../utils/sentinel-resolver.js';
import { getErrorMessage } from '../utils/error-message.js';
import { OwnedRecordingError, type BookService, type BookWithAuthor } from './book.service.js';
import type { ImportListType } from '@shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '@shared/schemas/import-list.js';
import type { ImportListRow } from './types.js';
import { triggerImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { AppSettings } from '@shared/schemas.js';
import type { RecordingReviewReason } from '@shared/schemas/recording-verdict.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

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

  /** Resolve shared metadata, preserving failed only for a genuine no-match; transient states stay pending. */
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
      // A genuine no-match becomes failed so the one-hour search retry can recover it.
      return { match: null, enrichmentStatus: 'failed' };
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        // Provider failures stay pending; they are not evidence of no match.
        this.log.warn({ title: item.title, provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Metadata resolution rate limited; leaving book pending');
        return { match: null, enrichmentStatus: undefined };
      }
      if (error instanceof TransientError) {
        this.log.warn({ title: item.title, provider: error.provider }, 'Metadata resolution hit a transient provider error; leaving book pending');
        return { match: null, enrichmentStatus: undefined };
      }
      this.log.warn({ title: item.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
      return { match: null, enrichmentStatus: undefined };
    }
  }

  private logIdentityMismatch(item: ImportListItem, match: BookMetadata): void {
    const metadataAuthor = match.authors[0]?.name;
    const titleDiffers = !!item.title && item.title.toLowerCase() !== match.title.toLowerCase();
    const authorDiffers = !!item.author && !!metadataAuthor && item.author.toLowerCase() !== metadataAuthor.toLowerCase();
    if (!titleDiffers && !authorDiffers) return;
    this.log.warn(
      {
        asin: match.asin ?? item.asin,
        listTitle: item.title,
        metadataTitle: match.title,
        listAuthor: item.author,
        metadataAuthor,
      },
      'Import-list metadata disagrees with raw provider fields; adopting resolved metadata',
    );
  }

  private async resolveImportDisposition(enriched: EnrichedItem) {
    const authorList = enriched.authorName ? [{ name: enriched.authorName }] : undefined;
    return this.bookService.findDuplicate({
      title: enriched.title,
      ...(authorList && { authors: authorList }),
      ...(enriched.asin !== undefined && { asin: enriched.asin }),
      ...(enriched.narrators !== undefined && { narrators: enriched.narrators }),
      ...(enriched.duration != null && { duration: enriched.duration }),
      // Without normalized production type, abridged/unabridged items lacking duration collapse (#1728 F1).
      ...(enriched.productionType !== undefined && { productionType: enriched.productionType }),
    });
  }

  /** Import lists have no review UI; persist held candidates on the incumbent's history (#1735). */
  private async recordReviewSkip(
    enriched: EnrichedItem,
    list: ImportListRow,
    existingBookId: number | null,
    recordingReviewReason: RecordingReviewReason | undefined,
  ): Promise<void> {
    this.log.info(
      { title: enriched.title, asin: enriched.asin, existingBookId, recordingReviewReason },
      'Import-list item needs recording review — recording held-review event',
    );
    await this.db.insert(bookEvents).values({
      bookId: existingBookId,
      bookTitle: enriched.title,
      authorName: enriched.authorName ?? null,
      eventType: 'recording_review_skipped',
      source: 'import_list',
      // Unstructured reason JSON preserves the machine downgrade reason without a migration (#1728).
      reason: { importListName: list.name, existingBookId, ...(recordingReviewReason && { recordingReviewReason }) },
    });
  }

  /** Treat a create-time same-ASIN race as an owned skip with no enqueue (#1711). */
  private async createImportListBook(enriched: EnrichedItem, enrichmentStatus: 'failed' | undefined, list: ImportListRow): Promise<BookWithAuthor | null> {
    try {
      return await this.bookService.create({
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
        duration: enriched.duration,
        publishedDate: enriched.publishedDate,
        genres: enriched.genres,
        productionType: enriched.productionType,
        status: 'wanted',
        enrichmentStatus,
        importListId: list.id,
      });
    } catch (error: unknown) {
      if (error instanceof OwnedRecordingError) {
        this.log.info({ title: enriched.title, asin: enriched.asin, existingBookId: error.existingBookId }, 'Import-list item already owned (ASIN race), skipped');
        return null;
      }
      throw error;
    }
  }

  private async processItem(item: ImportListItem, list: ImportListRow, qualitySettings?: QualitySettings): Promise<ItemOutcome> {
    const { enriched, enrichmentStatus } = await this.enrichItem(item);

    const resolution = await this.resolveImportDisposition(enriched);
    if (resolution.verdict === 'same-recording') {
      this.log.debug({ title: enriched.title, asin: enriched.asin }, 'Book already exists (same recording), skipped');
      return 'skipped';
    }
    if (resolution.verdict === 'review') {
      await this.recordReviewSkip(enriched, list, resolution.book?.id ?? null, resolution.recordingReviewReason);
      return 'held_review';
    }

    const created = await this.createImportListBook(enriched, enrichmentStatus, list);
    if (!created) return 'skipped';

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
    return 'created';
  }
}

/**
 * Resolved identity is canonical while raw cover/description/ISBN remain preferred hints.
 * Keep this outside the class so fallback operators do not inflate `enrichItem` complexity.
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
  const primarySeries = pickPrimarySeries(match);
  return {
    title: match.title,
    authorName: match.authors[0]?.name,
    coverUrl: item.coverUrl ?? match.coverUrl,
    subtitle: match.subtitle,
    description: item.description ?? match.description,
    publisher: match.publisher,
    seriesName: primarySeries?.name,
    seriesPosition: primarySeries?.position,
    narrators: match.narrators,
    duration: match.duration,
    publishedDate: match.publishedDate,
    genres: match.genres,
    // Search fallback may replace a print/Kindle ASIN with the resolved audiobook ASIN.
    asin: match.asin ?? item.asin,
    isbn: item.isbn ?? match.isbn,
    // Persist only actual format signal; undefined preserves the DB default (#1731).
    productionType: match.formatType ? normalizeProductionType(match.formatType) : undefined,
  };
}

interface EnrichedItem {
  title: string;
  coverUrl?: string | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  narrators?: string[] | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  authorName?: string | undefined;
  productionType?: ProductionType | undefined;
}
