import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloadClients } from '../../db/schema.js';
import {
  DOWNLOAD_CLIENT_ADAPTER_FACTORIES,
  type DownloadClientAdapter,
  type DownloadProtocol,
} from '../../core/index.js';
import { DOWNLOAD_CLIENT_REGISTRY } from '../../shared/download-client-registry.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey } from '../utils/secret-codec.js';

type DownloadClientRow = typeof downloadClients.$inferSelect;
type NewDownloadClient = typeof downloadClients.$inferInsert;

export class DownloadClientService {
  private adapters: Map<number, DownloadClientAdapter> = new Map();

  constructor(private db: Db, private log: FastifyBaseLogger) {}

  private decryptRow(row: DownloadClientRow): DownloadClientRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('downloadClient', s, getKey()) };
  }

  clearAdapterCache(): void {
    this.adapters.clear();
  }

  async getAll(): Promise<DownloadClientRow[]> {
    const rows = await this.db.select().from(downloadClients).orderBy(downloadClients.priority);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.id, id))
      .limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async getFirstEnabled(): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.enabled, true))
      .orderBy(downloadClients.priority)
      .limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async getFirstEnabledForProtocol(protocol: DownloadProtocol): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.enabled, true))
      .orderBy(downloadClients.priority);
    const match = results.find((c) => {
      const meta = DOWNLOAD_CLIENT_REGISTRY[c.type];
      if (!meta) return false;
      if (meta.protocol === 'per-instance') {
        const settings = c.settings as Record<string, unknown>;
        return (settings.protocol as string) === protocol;
      }
      return meta.protocol === protocol;
    }) || null;
    this.log.debug({ protocol, found: match?.name ?? null, candidates: results.length }, 'Download client lookup for protocol');
    return match ? this.decryptRow(match) : null;
  }

  async create(data: Omit<NewDownloadClient, 'id' | 'createdAt'>): Promise<DownloadClientRow> {
    const toInsert = { ...data };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('downloadClient', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(downloadClients).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Download client created');
    return this.decryptRow(result[0]);
  }

  async update(
    id: number,
    data: Partial<NewDownloadClient>
  ): Promise<DownloadClientRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(downloadClients).where(eq(downloadClients.id, id)).limit(1);
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>);
      toUpdate.settings = encryptFields('downloadClient', settings, getKey());
    }
    const result = await this.db
      .update(downloadClients)
      .set(toUpdate)
      .where(eq(downloadClients.id, id))
      .returning();

    // Clear cached adapter
    this.adapters.delete(id);

    this.log.info({ id }, 'Download client updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(downloadClients).where(eq(downloadClients.id, id));
    this.adapters.delete(id);
    this.log.info({ id }, 'Download client deleted');
    return true;
  }

  async getAdapter(clientId: number): Promise<DownloadClientAdapter | null> {
    let adapter = this.adapters.get(clientId);

    if (!adapter) {
      const client = await this.getById(clientId);
      if (!client) return null;

      adapter = this.createAdapter(client);
      this.adapters.set(clientId, adapter);
    }

    return adapter;
  }

  async getFirstEnabledAdapter(): Promise<DownloadClientAdapter | null> {
    const client = await this.getFirstEnabled();
    if (!client) return null;
    return this.getAdapter(client.id);
  }

  private createAdapter(client: DownloadClientRow): DownloadClientAdapter {
    const settings = client.settings as Record<string, unknown>;
    const factory = DOWNLOAD_CLIENT_ADAPTER_FACTORIES[client.type];
    if (!factory) {
      throw new Error(`Unknown download client type: ${client.type}`);
    }
    this.log.debug({ client: client.name, type: client.type }, 'Creating download client adapter');
    return factory(settings, { onWarn: (msg) => this.log.warn(msg) });
  }

  async testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string }> {
    try {
      this.log.debug({ type: data.type, host: data.settings.host, port: data.settings.port, useSsl: data.settings.useSsl }, 'Testing download client config');
      const fakeRow = { id: 0, name: '', type: data.type, enabled: true, priority: 0, settings: data.settings, createdAt: new Date() } as DownloadClientRow;
      const adapter = this.createAdapter(fakeRow);
      const result = await adapter.test();
      this.log.debug({ type: data.type, success: result.success, message: result.message }, 'Download client config test result');
      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getCategories(id: number): Promise<{ categories: string[]; error?: string }> {
    const adapter = await this.getAdapter(id);
    if (!adapter) {
      return { categories: [], error: 'Download client not found' };
    }

    if (!adapter.supportsCategories) {
      return { categories: [] };
    }

    try {
      const categories = await adapter.getCategories();
      this.log.debug({ id, count: categories.length }, 'Fetched download client categories');
      return { categories };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log.warn({ id, error }, 'Failed to fetch categories from download client');
      return { categories: [], error: message };
    }
  }

  async getCategoriesFromConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ categories: string[]; error?: string }> {
    try {
      this.log.debug({ type: data.type }, 'Fetching categories from download client config');
      const fakeRow = { id: 0, name: '', type: data.type, enabled: true, priority: 0, settings: data.settings, createdAt: new Date() } as DownloadClientRow;
      const adapter = this.createAdapter(fakeRow);

      if (!adapter.supportsCategories) {
        return { categories: [] };
      }

      const categories = await adapter.getCategories();
      return { categories };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log.warn({ type: data.type, error }, 'Failed to fetch categories from download client config');
      return { categories: [], error: message };
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
    const client = await this.getById(id);
    if (!client) {
      return { success: false, message: 'Download client not found' };
    }

    try {
      const adapter = this.createAdapter(client);
      const result = await adapter.test();
      this.log.debug({ id, success: result.success }, 'Download client test result');
      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
