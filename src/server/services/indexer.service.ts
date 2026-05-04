import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '../../db/schema.js';
import {
  INDEXER_ADAPTER_FACTORIES,
  type IndexerAdapter,
  type IndexerTestResult,
} from '../../core/index.js';
import type { SettingsService } from './settings.service.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import type { IndexerSettings } from '../../shared/schemas/indexer.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import type { IndexerRow } from './types.js';


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
    return this.decryptRow(result[0]!);
  }

  async update(id: number, data: Partial<NewIndexer>): Promise<IndexerRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('indexer'));
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

  async getAllProwlarrManaged(): Promise<IndexerRow[]> {
    const rows = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.source, 'prowlarr'))
      .orderBy(indexers.priority);
    return rows.map((r) => this.decryptRow(r));
  }

  async getByIdProwlarrManaged(id: number): Promise<IndexerRow | null> {
    const results = await this.db
      .select()
      .from(indexers)
      .where(and(eq(indexers.id, id), eq(indexers.source, 'prowlarr')))
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
    const settings = indexer.settings as IndexerSettings;
    const factory = INDEXER_ADAPTER_FACTORIES[indexer.type as keyof typeof INDEXER_ADAPTER_FACTORIES];
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

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<IndexerTestResult> {
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
        resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('indexer'));
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
        message: getErrorMessage(error),
      };
    }
  }

  async test(id: number): Promise<IndexerTestResult> {
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
          this.log.warn({ id, error: serializeError(error) }, 'Failed to persist VIP metadata after test');
        }
      }

      return result;
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }
}
