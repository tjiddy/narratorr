import { eq, and, lte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importLists, bookEvents } from '../../db/schema.js';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '../../core/import-lists/index.js';
import type { ImportListItem } from '../../core/import-lists/index.js';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/types.js';
import { diceCoefficient } from '../../core/utils/similarity.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { BookService } from './book.service.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import { importListSettingsSchemas, type ImportListSettings } from '../../shared/schemas/import-list.js';
import type { ImportListRow } from './types.js';
import { triggerImmediateSearch, type ImmediateSearchDeps } from '../routes/trigger-immediate-search.js';
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
   * Resolve the rich metadata for an import-list item.
   *
   * Two paths:
   * - **ASIN-identity** — when `item.asin` is present, hit Audnexus directly
   *   (`enrichBook(asin)`). Identity lookup, no fuzzy validation. The metadata
   *   is treated as canonical identity: a successful match wins title/authors
   *   over the raw provider fields.
   * - **Search-candidate** — when `item.asin` is absent, run a metadata search
   *   and validate the top candidate via {@link matchPassesValidation}. Failed
   *   validation drops the match (raw provider fields fall through).
   *
   * Either path can return `source: 'none'` (no metadata service, lookup
   * failed, search empty, validation rejected) — callers then fall back to raw
   * item fields with no metadata side fields populated. Provider-first
   * precedence still applies to cover/description/asin/isbn even on the
   * matched branches; only title/authorName flip to metadata-first.
   */
  private async enrichItem(item: ImportListItem): Promise<EnrichedItem> {
    const resolved = await this.resolveMatch(item);
    return buildEnrichedItem(item, resolved);
  }

  private async resolveMatch(item: ImportListItem): Promise<ResolvedMatch> {
    if (!this.metadata) return { match: null, source: 'none' };
    try {
      if (item.asin) {
        // ASIN-identity path: trust Audnexus's response, no fuzzy validation
        const match = await this.metadata.enrichBook(item.asin);
        if (!match) return { match: null, source: 'none' };
        this.logIdentityMismatch(item, match);
        return { match, source: 'asin' };
      }
      const query = item.author ? `${item.title} ${item.author}` : item.title;
      const searchResults = await this.metadata.search(query);
      const candidate = searchResults.books[0];
      if (!candidate) return { match: null, source: 'none' };
      return matchPassesValidation(item, candidate)
        ? { match: candidate, source: 'search' }
        : { match: null, source: 'none' };
    } catch (error: unknown) {
      this.log.warn({ title: item.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
      return { match: null, source: 'none' };
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
    const enriched = await this.enrichItem(item);

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
      description: enriched.description,
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
      importListId: list.id,
    });

    await this.db.insert(bookEvents).values({
      bookId: created.id,
      bookTitle: created.title,
      authorName: enriched.authorName ?? null,
      eventType: 'grabbed',
      source: 'import_list',
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
 * Outcome of resolving rich metadata for an import-list item.
 *
 * `source` tags which path produced the match so {@link buildEnrichedItem}
 * can apply source-aware precedence: matched paths (`'asin'` / `'search'`)
 * adopt metadata identity (title/authorName); the `'none'` path falls back
 * to raw provider fields with no metadata side fields.
 */
type ResolvedMatch =
  | { match: BookMetadata; source: 'asin' | 'search' }
  | { match: null; source: 'none' };

/**
 * Build the intermediate enriched payload from `(item, resolved)`.
 *
 * Source-aware precedence:
 * - `'asin'` / `'search'` — metadata wins for `title` and `authorName` (the
 *   match is treated as canonical identity). `BookMetadataSchema` requires
 *   `title` and a non-empty `authors`, so no per-field fallback is needed
 *   inside a successful branch. Provider-first still applies to
 *   cover/description/asin/isbn (raw item value is a hint).
 * - `'none'` — raw item fields only; no metadata side fields populated.
 *
 * `seriesPrimary` wins over `series[0]` (#1088 / #1097).
 *
 * Lives outside the class so its many `??`/`?.` operators don't accumulate
 * cyclomatic complexity in `enrichItem`.
 */
function buildEnrichedItem(item: ImportListItem, resolved: ResolvedMatch): EnrichedItem {
  if (resolved.source === 'none') return buildRawEnriched(item);
  return buildMatchedEnriched(item, resolved.match);
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

// eslint-disable-next-line complexity -- flat coalescing across item/match
function buildMatchedEnriched(item: ImportListItem, match: BookMetadata): EnrichedItem {
  const primarySeries = match.seriesPrimary ?? match.series?.[0];
  return {
    title: match.title,
    authorName: match.authors[0]?.name,
    coverUrl: item.coverUrl ?? match.coverUrl,
    description: item.description ?? match.description,
    seriesName: primarySeries?.name,
    seriesPosition: primarySeries?.position,
    seriesAsin: primarySeries?.asin,
    narrators: match.narrators,
    duration: match.duration,
    publishedDate: match.publishedDate,
    genres: match.genres,
    asin: item.asin ?? match.asin,
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
  description?: string | undefined;
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

/** Title fuzzy threshold for search-candidate path (Dice coefficient). */
const TITLE_MATCH_THRESHOLD = 0.7;

/**
 * AND-gate for adopting a search match (search-candidate path only).
 *
 * Title check: dice(item.title, candidate.title) ≥ threshold (always required).
 * Author check: case-insensitive overlap (full or last-name token), only
 * required when `item.author` is present.
 *
 * If either required check fails → reject. Mirrors AC §4: prevents "Golden Son
 * by Pierce Brown" cover/series getting attached to a NYT entry that's actually
 * "Golden Son by Some Romance Author".
 */
function matchPassesValidation(item: ImportListItem, candidate: BookMetadata): boolean {
  if (diceCoefficient(item.title, candidate.title) < TITLE_MATCH_THRESHOLD) return false;
  if (!item.author) return true;
  const candidateAuthors = candidate.authors?.map((a) => a.name).filter(Boolean) ?? [];
  if (candidateAuthors.length === 0) return false;
  return candidateAuthors.some((name) => authorOverlap(item.author!, name));
}

function authorOverlap(a: string, b: string): boolean {
  const aLower = a.trim().toLowerCase();
  const bLower = b.trim().toLowerCase();
  if (!aLower || !bLower) return false;
  if (aLower === bLower) return true;
  // Last-name overlap (last whitespace-delimited token)
  const aLast = aLower.split(/\s+/).pop()!;
  const bLast = bLower.split(/\s+/).pop()!;
  return aLast.length > 1 && aLast === bLast;
}
