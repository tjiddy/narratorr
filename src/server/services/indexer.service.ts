import { eq, and } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '@db/schema.js';
import {
  INDEXER_ADAPTER_FACTORIES,
  type IndexerAdapter,
  type IndexerTestResult,
} from '@core/index.js';
import type { SettingsService } from './settings.service.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings, resolveSettings } from '../utils/sentinel-resolver.js';
import { indexerSettingsSchemas, type IndexerSettings } from '@shared/schemas/indexer.js';
import { parseEntitySettings } from '../utils/parse-entity-settings.js';
import { stripReadarrEchoOnlyFields } from '../utils/readarr-echo-fields.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import type { IndexerRow } from './types.js';
import { type LanAllowlist } from '@core/utils/download-url.js';
import { normalizedHostPortFromUrl, normalizedHostnameFromUrl } from '@core/utils/network-service.js';
import {
  IndexerFailureTracker,
  classifyIndexerFailure,
  type IndexerFailureSnapshot,
} from './indexer-failure-state.js';

export type { LanAllowlist } from '@core/utils/download-url.js';


type NewIndexer = typeof indexers.$inferInsert;

/** The synchronous gate verdict, plus everything the caller needs to report and later commit. */
export interface IndexerAttemptDecision {
  allowed: boolean;
  /** Read at reserve time and handed back at commit time to detect an intervening clear. */
  generation: number;
  snapshot: IndexerFailureSnapshot;
}

export class IndexerService {
  private adapters = new AdapterCache<IndexerAdapter>();
  // The search breaker (#2376). It lives here, not on the search service, because the clears
  // (AC17) and the health-probe recovery hook (AC7) are all writes this class already owns.
  private failures: IndexerFailureTracker;

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private settingsService?: SettingsService,
    clock: () => number = Date.now,
  ) {
    this.failures = new IndexerFailureTracker(clock);
  }

  private decryptRow(row: IndexerRow): IndexerRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('indexer', s, getKey(), this.log) };
  }

  async getAll(): Promise<IndexerRow[]> {
    const rows = await this.db.select().from(indexers).orderBy(indexers.priority);
    return rows.map((r) => this.decryptRow(r));
  }

  /** Allow configured indexer hosts through LAN SSRF policy; invalid apiUrls contribute nothing. */
  async getLanAllowlist(): Promise<LanAllowlist> {
    const indexerRows = await this.getAll();
    const hostPort = new Set<string>();
    const hostname = new Set<string>();
    for (const row of indexerRows) {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      const apiUrl = typeof settings.apiUrl === 'string' ? settings.apiUrl.trim() : '';
      if (!apiUrl) continue;
      let parsed: URL;
      try {
        parsed = new URL(apiUrl);
      } catch {
        this.log.debug({ indexerId: row.id, indexerName: row.name }, 'Skipping un-parseable indexer apiUrl in LAN allowlist');
        continue;
      }
      hostPort.add(normalizedHostPortFromUrl(parsed));
      hostname.add(normalizedHostnameFromUrl(parsed));
    }
    return { hostPort, hostname };
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

  /**
   * The operator-configuration mutator: a config or credential change is a repair signal, so it
   * clears the breaker. An internal observation write must use `persistObservedSettings` instead
   * — clearing there would bump the generation mid-search and discard that leg's own outcome.
   * Preserve is the safe default: a missed clear costs at most one health cycle, a spurious one
   * silently discards real failure history.
   */
  async update(id: number, data: Partial<NewIndexer>): Promise<IndexerRow | null> {
    const row = await this.writeIndexer(id, data);
    this.failures.clear(id);
    return row;
  }

  /** The same write and adapter eviction, with no repair signal. See `update`. */
  async persistObservedSettings(id: number, settings: Record<string, unknown>): Promise<IndexerRow | null> {
    return this.writeIndexer(id, { settings });
  }

  private async writeIndexer(id: number, data: Partial<NewIndexer>): Promise<IndexerRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const existing = await this.db.select().from(indexers).where(eq(indexers.id, id)).limit(1);
      toUpdate.settings = resolveAndEncryptSettings('indexer', toUpdate.settings as Record<string, unknown>, existing[0]?.settings as Record<string, unknown> | undefined);
    }
    const result = await this.db
      .update(indexers)
      .set(toUpdate)
      .where(eq(indexers.id, id))
      .returning();

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
    // AUTOINCREMENT never reissues an id, so a recreated indexer cannot inherit this state.
    this.failures.clear(id);
    this.log.info({ id }, 'Indexer deleted');
    return true;
  }

  getFailureSnapshot(id: number): IndexerFailureSnapshot {
    return this.failures.get(id);
  }

  getFailureGeneration(id: number): number {
    return this.failures.generation(id);
  }

  /**
   * AC21's gate. Synchronous by contract: callers must invoke it as the first statement of a
   * per-indexer leg, before any `await`, or two legs both find a reopened window open.
   */
  reserveSearchAttempt(id: number): IndexerAttemptDecision {
    const allowed = this.failures.reserveAttempt(id);
    return { allowed, generation: this.failures.generation(id), snapshot: this.failures.get(id) };
  }

  recordSearchSuccess(id: number, generation: number): void {
    this.failures.recordSuccess(id, generation);
  }

  recordSearchFailure(id: number, error: unknown, generation: number): void {
    const verdict = classifyIndexerFailure(error);
    if (verdict.terminal) this.failures.recordTerminalFailure(id, verdict.reason, generation);
    else this.failures.recordTransientFailure(id, verdict.reason, generation);
  }

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

  async createOrUpsertProwlarr(data: {
    name: string;
    type: NewIndexer['type'];
    enabled: boolean;
    priority: number;
    settings: Record<string, unknown>;
    sourceIndexerId: number | null;
  }): Promise<{ row: IndexerRow; upserted: boolean }> {
    if (data.sourceIndexerId !== null) {
      const existing = await this.findByProwlarrSource(data.sourceIndexerId);
      if (existing) {
        // Replace Prowlarr fields but preserve local priority, enabled state, and unprovided settings.
        const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
        // Strip legacy Readarr echo fields before strict adapter validation.
        const mergedSettings = stripReadarrEchoOnlyFields({ ...existingSettings, ...data.settings });
        const updated = await this.update(existing.id, {
          name: data.name,
          type: data.type,
          settings: mergedSettings,
          source: 'prowlarr',
          sourceIndexerId: data.sourceIndexerId,
        });
        this.log.info({ id: existing.id, sourceIndexerId: data.sourceIndexerId }, 'Prowlarr indexer upserted');
        return { row: updated!, upserted: true };
      }
    }

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
      // Ensure settings are decrypted before creating the adapter.
      const decrypted = this.decryptRow(indexer);
      adapter = this.createAdapter(decrypted, proxyUrl);
      this.adapters.set(indexer.id, adapter);
    }

    return adapter;
  }

  private createAdapter(indexer: IndexerRow, proxyUrl?: string): IndexerAdapter {
    const factory = INDEXER_ADAPTER_FACTORIES[indexer.type as keyof typeof INDEXER_ADAPTER_FACTORIES];
    if (!factory) {
      throw new Error(`Unknown indexer type: ${indexer.type}`);
    }

    const settings = parseEntitySettings<IndexerSettings>(
      indexerSettingsSchemas,
      indexer.type,
      indexer.settings as Record<string, unknown>,
    );

    // Pass proxy only when enabled; adapters resolve FlareSolverr precedence.
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

      // Resolve masked sentinels against saved settings when editing.
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Indexer not found' };
        }
        resolvedSettings = resolveSettings('indexer', data.settings, existing.settings as Record<string, unknown> | undefined);
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

  /**
   * Both the operator's Test button and the scheduled health probe. Never gated by the breaker
   * (AC8): suppressing it is what would make `stopped` permanent, since this is the only call
   * that can discover a recovery. Its success is the designated recovery signal and clears the
   * breaker from any state, including `stopped` — unlike a search success, which by then can
   * only be a stale in-flight leg from before the stop (AC22).
   */
  async test(id: number): Promise<IndexerTestResult> {
    const indexer = await this.getById(id);
    if (!indexer) {
      return { success: false, message: 'Indexer not found' };
    }

    const generation = this.failures.generation(id);
    try {
      const adapter = await this.getAdapter(indexer);
      const result = await adapter.test();
      this.log.debug({ id, success: result.success }, 'Indexer test result');

      if (!result.success) {
        this.recordSearchFailure(id, new Error(result.message), generation);
        return result;
      }

      if (result.metadata && 'isVip' in result.metadata) {
        try {
          const existingSettings = (indexer.settings ?? {}) as Record<string, unknown>;
          const updates: Record<string, unknown> = { isVip: result.metadata.isVip };
          if ('classname' in result.metadata) {
            updates.classname = result.metadata.classname;
          }
          // The non-clearing writer, so a successful probe produces exactly one clear below.
          await this.persistObservedSettings(id, { ...existingSettings, ...updates });
          this.log.info({ id, isVip: result.metadata.isVip, classname: result.metadata.classname }, 'Persisted VIP/class status from test');
        } catch (error: unknown) {
          this.log.warn({ id, error: serializeError(error) }, 'Failed to persist VIP metadata after test');
        }
      }

      this.failures.clear(id);
      return result;
    } catch (error: unknown) {
      this.recordSearchFailure(id, error, generation);
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }
}
