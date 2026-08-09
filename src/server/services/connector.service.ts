import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { connectors } from '@db/schema.js';
import {
  ADAPTER_FACTORIES,
  ConnectorRequestError,
  type ConnectorAdapter,
  type ConnectorImportItem,
  type ConnectorReason,
  type ConnectorTarget,
  type ConnectorTestResult,
} from '@core/connectors/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { z } from 'zod';
import { connectorSettingsSchemas, connectorTargetsSettingsSchemas, type ConnectorSettings } from '@shared/schemas/connector.js';
import { parseEntitySettings } from '../utils/parse-entity-settings.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings, resolveSettings } from '../utils/sentinel-resolver.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import {
  ConnectorRefreshQueue,
  FlushResolutionError,
  type ConnectorLogContext,
  type ConnectorRefreshQueueOptions,
  type PendingFlush,
  type ResolvedFlush,
} from './connector-refresh-queue.js';
import type { ConnectorRow } from './types.js';

type NewConnector = typeof connectors.$inferInsert;

export type ConnectorTargetsResult =
  | { success: true; targets: ConnectorTarget[] }
  | (ConnectorTestResult & { success: false });

export type ConnectorServiceOptions = ConnectorRefreshQueueOptions;

/**
 * Owns CRUD and adapter state; ConnectorRefreshQueue owns scheduling and retries.
 * Queue closures use app-scoped DB/log instances because they outlive triggering requests.
 */
export class ConnectorService {
  private adapters = new AdapterCache<ConnectorAdapter>();
  private readonly queue: ConnectorRefreshQueue;

  constructor(private db: Db, private log: FastifyBaseLogger, opts: ConnectorServiceOptions = {}) {
    this.queue = new ConnectorRefreshQueue((entry) => this.resolveFlush(entry), log, opts);
  }

  private decryptRow(row: ConnectorRow): ConnectorRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('connector', s, getKey(), this.log) };
  }

  async getAll(): Promise<ConnectorRow[]> {
    const rows = await this.db.select().from(connectors);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<ConnectorRow | null> {
    const results = await this.db.select().from(connectors).where(eq(connectors.id, id)).limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async create(data: Omit<NewConnector, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConnectorRow> {
    const toInsert = { ...data };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('connector', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(connectors).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Connector created');
    return this.decryptRow(result[0]!);
  }

  async update(id: number, data: Partial<NewConnector>): Promise<ConnectorRow | null> {
    const toUpdate: Partial<NewConnector> = { ...data, updatedAt: new Date() };
    if (toUpdate.settings) {
      const existing = await this.db.select().from(connectors).where(eq(connectors.id, id)).limit(1);
      toUpdate.settings = resolveAndEncryptSettings('connector', toUpdate.settings as Record<string, unknown>, existing[0]?.settings as Record<string, unknown> | undefined);
    }
    const result = await this.db.update(connectors).set(toUpdate).where(eq(connectors.id, id)).returning();

    this.adapters.delete(id);
    this.log.info({ id }, 'Connector updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;
    await this.db.delete(connectors).where(eq(connectors.id, id));
    this.adapters.delete(id);
    this.log.info({ id }, 'Connector deleted');
    return true;
  }

  getAdapter(connector: ConnectorRow): ConnectorAdapter {
    let adapter = this.adapters.get(connector.id);
    if (!adapter) {
      const decrypted = this.decryptRow(connector);
      adapter = this.createAdapter(decrypted);
      this.adapters.set(connector.id, adapter);
    }
    return adapter;
  }

  private createAdapter(
    connector: ConnectorRow,
    schemas: Record<string, z.ZodTypeAny> = connectorSettingsSchemas,
  ): ConnectorAdapter {
    const factory = ADAPTER_FACTORIES[connector.type];
    if (!factory) throw new Error(`Unknown connector type: ${connector.type}`);
    const settings = parseEntitySettings<ConnectorSettings>(
      schemas,
      connector.type,
      connector.settings as Record<string, unknown>,
    );
    return factory(settings);
  }

  clearAdapterCache(): void {
    this.adapters.clear();
  }

  async test(id: number): Promise<ConnectorTestResult> {
    const connector = await this.getById(id);
    if (!connector) return { success: false, message: 'Connector not found' };
    try {
      return await this.getAdapter(connector).test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<ConnectorTestResult> {
    try {
      const adapter = await this.adapterForConfig(data);
      return await adapter.test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async listTargets(id: number): Promise<ConnectorTargetsResult> {
    const connector = await this.getById(id);
    if (!connector) return { success: false, message: 'Connector not found' };
    return this.runTargets(() => this.getAdapter(connector).listTargets());
  }

  async listTargetsConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<ConnectorTargetsResult> {
    let adapter: ConnectorAdapter;
    try {
      // Target discovery cannot require the selector field it populates.
      adapter = await this.adapterForConfig(data, connectorTargetsSettingsSchemas);
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
    return this.runTargets(() => adapter.listTargets());
  }

  private async runTargets(fn: () => Promise<ConnectorTarget[]>): Promise<ConnectorTargetsResult> {
    try {
      return { success: true, targets: await fn() };
    } catch (error: unknown) {
      if (error instanceof ConnectorRequestError) {
        return { success: false, message: error.message, ...(error.fieldErrors && { fieldErrors: error.fieldErrors }) };
      }
      return { success: false, message: getErrorMessage(error) };
    }
  }

  // Resolve saved secret sentinels; callers choose strict or selector-optional validation.
  private async adapterForConfig(
    data: { type: string; settings: Record<string, unknown>; id?: number },
    schemas: Record<string, z.ZodTypeAny> = connectorSettingsSchemas,
  ): Promise<ConnectorAdapter> {
    let resolvedSettings = data.settings;
    if (data.id != null) {
      const existing = await this.getById(data.id);
      if (!existing) throw new Error('Connector not found');
      resolvedSettings = resolveSettings('connector', data.settings, existing.settings as Record<string, unknown> | undefined);
    }
    const fakeRow = { id: 0, name: '', type: data.type, enabled: true, settings: resolvedSettings, createdAt: new Date(), updatedAt: new Date() } as ConnectorRow;
    return this.createAdapter(fakeRow, schemas);
  }

  // Import paths call this fire-and-forget after the enabled-connector preflight.
  async notifyRefresh(reason: ConnectorReason, items: ConnectorImportItem[]): Promise<void> {
    if (items.length === 0) return;
    const enabled = await this.db.select().from(connectors).where(eq(connectors.enabled, true));
    for (const connector of enabled) {
      for (const item of items) {
        this.queue.enqueue(connector.id, reason, item);
      }
    }
  }

  stop(): Promise<void> {
    return this.queue.stop();
  }

  /**
   * Re-resolve at flush time and skip disabled or missing connectors.
   * Once a row exists, wrap resolution failures with its log context.
   */
  private async resolveFlush(entry: PendingFlush): Promise<ResolvedFlush | null> {
    const connector = await this.getById(entry.connectorId);
    if (!connector || !connector.enabled) return null;
    // Assemble the redacted host before getAdapter so later failures still carry it.
    const logContext: ConnectorLogContext = {
      connectorId: connector.id,
      connectorType: connector.type,
      connectorName: connector.name,
      url: redactBaseUrl(connector.settings),
    };
    try {
      const adapter = this.getAdapter(connector);
      const batch = { reasons: entry.reasons, items: entry.items };
      // Scale the watchdog for adapters that issue sequential requests.
      const requestCount = Math.max(1, adapter.estimateRequestCount(batch));
      return { requestCount, logContext, run: (signal) => adapter.refreshImport(batch, signal) };
    } catch (error: unknown) {
      throw new FlushResolutionError(logContext, error);
    }
  }
}

/** Extract a host-only (credential-free) form of the connector base URL for logging. */
function redactBaseUrl(settings: unknown): string {
  const raw = (settings as Record<string, unknown> | null)?.baseUrl;
  if (typeof raw !== 'string' || !raw) return '[unknown]';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[unparseable]';
  }
}
