import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import { downloadClients } from '@narratorr/db/schema';
import {
  QBittorrentClient,
  type DownloadClientAdapter,
  type QBittorrentConfig,
} from '@narratorr/core';

type DownloadClientRow = typeof downloadClients.$inferSelect;
type NewDownloadClient = typeof downloadClients.$inferInsert;

export class DownloadClientService {
  private adapters: Map<number, DownloadClientAdapter> = new Map();

  constructor(private db: Db) {}

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

  async create(data: Omit<NewDownloadClient, 'id' | 'createdAt'>): Promise<DownloadClientRow> {
    const result = await this.db.insert(downloadClients).values(data).returning();
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

    return result[0] || null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(downloadClients).where(eq(downloadClients.id, id));
    this.adapters.delete(id);
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

    switch (client.type) {
      case 'qbittorrent': {
        const config: QBittorrentConfig = {
          host: (settings.host as string) || 'localhost',
          port: (settings.port as number) || 8080,
          username: (settings.username as string) || 'admin',
          password: (settings.password as string) || '',
          useSsl: (settings.useSsl as boolean) || false,
        };
        return new QBittorrentClient(config);
      }
      default:
        throw new Error(`Unknown download client type: ${client.type}`);
    }
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
    const client = await this.getById(id);
    if (!client) {
      return { success: false, message: 'Download client not found' };
    }

    try {
      const adapter = this.createAdapter(client);
      return adapter.test();
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
