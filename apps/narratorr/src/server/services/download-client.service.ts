import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { downloadClients } from '@narratorr/db/schema';
import {
  QBittorrentClient,
  SABnzbdClient,
  NZBGetClient,
  TransmissionClient,
  type DownloadClientAdapter,
  type DownloadProtocol,
  type QBittorrentConfig,
  type SABnzbdConfig,
  type NZBGetConfig,
  type TransmissionConfig,
} from '@narratorr/core';

type DownloadClientRow = typeof downloadClients.$inferSelect;
type NewDownloadClient = typeof downloadClients.$inferInsert;

const CLIENT_PROTOCOL: Record<string, DownloadProtocol> = {
  qbittorrent: 'torrent',
  transmission: 'torrent',
  sabnzbd: 'usenet',
  nzbget: 'usenet',
};

export class DownloadClientService {
  private adapters: Map<number, DownloadClientAdapter> = new Map();

  constructor(private db: Db, private log: FastifyBaseLogger) {}

  clearAdapterCache(): void {
    this.adapters.clear();
  }

  async getAll(): Promise<DownloadClientRow[]> {
    return this.db.select().from(downloadClients).orderBy(downloadClients.priority);
  }

  async getById(id: number): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.id, id))
      .limit(1);
    return results[0] || null;
  }

  async getFirstEnabled(): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.enabled, true))
      .orderBy(downloadClients.priority)
      .limit(1);
    return results[0] || null;
  }

  async getFirstEnabledForProtocol(protocol: DownloadProtocol): Promise<DownloadClientRow | null> {
    const results = await this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.enabled, true))
      .orderBy(downloadClients.priority);
    const match = results.find((c) => CLIENT_PROTOCOL[c.type] === protocol) || null;
    this.log.debug({ protocol, found: match?.name ?? null, candidates: results.length }, 'Download client lookup for protocol');
    return match;
  }

  async create(data: Omit<NewDownloadClient, 'id' | 'createdAt'>): Promise<DownloadClientRow> {
    const result = await this.db.insert(downloadClients).values(data).returning();
    this.log.info({ name: data.name, type: data.type }, 'Download client created');
    return result[0];
  }

  async update(
    id: number,
    data: Partial<NewDownloadClient>
  ): Promise<DownloadClientRow | null> {
    const result = await this.db
      .update(downloadClients)
      .set(data)
      .where(eq(downloadClients.id, id))
      .returning();

    // Clear cached adapter
    this.adapters.delete(id);

    this.log.info({ id }, 'Download client updated');
    return result[0] || null;
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

  // eslint-disable-next-line complexity -- switch/case factory for 4 client types
  private createAdapter(client: DownloadClientRow): DownloadClientAdapter {
    const settings = client.settings as Record<string, unknown>;

    switch (client.type) {
      case 'qbittorrent': {
        const config: QBittorrentConfig = {
          host: (settings.host as string) || 'localhost',
          port: (settings.port as number) || 8080,
          username: (settings.username as string) || 'admin',
          password: (settings.password as string) || '',
          useSsl: (settings.useSsl as boolean) || false,
        };
        this.log.debug({ client: client.name, type: client.type, host: config.host, port: config.port, useSsl: config.useSsl }, 'Creating download client adapter');
        return new QBittorrentClient(config);
      }
      case 'sabnzbd': {
        const config: SABnzbdConfig = {
          host: (settings.host as string) || 'localhost',
          port: (settings.port as number) || 8080,
          apiKey: (settings.apiKey as string) || '',
          useSsl: (settings.useSsl as boolean) || false,
        };
        this.log.debug({ client: client.name, type: client.type, host: config.host, port: config.port }, 'Creating download client adapter');
        return new SABnzbdClient(config);
      }
      case 'nzbget': {
        const config: NZBGetConfig = {
          host: (settings.host as string) || 'localhost',
          port: (settings.port as number) || 6789,
          username: (settings.username as string) || 'nzbget',
          password: (settings.password as string) || '',
          useSsl: (settings.useSsl as boolean) || false,
        };
        this.log.debug({ client: client.name, type: client.type, host: config.host, port: config.port }, 'Creating download client adapter');
        return new NZBGetClient(config);
      }
      case 'transmission': {
        const config: TransmissionConfig = {
          host: (settings.host as string) || 'localhost',
          port: (settings.port as number) || 9091,
          username: (settings.username as string) || '',
          password: (settings.password as string) || '',
          useSsl: (settings.useSsl as boolean) || false,
        };
        this.log.debug({ client: client.name, type: client.type, host: config.host, port: config.port }, 'Creating download client adapter');
        return new TransmissionClient(config);
      }
      default:
        throw new Error(`Unknown download client type: ${client.type}`);
    }
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
