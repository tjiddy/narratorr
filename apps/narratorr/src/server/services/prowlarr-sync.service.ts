import { eq, and } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { indexers, settings } from '@narratorr/db/schema';
import { ProwlarrClient, type ProwlarrConfig, type ProwlarrProxyIndexer } from '@narratorr/core';

type IndexerRow = typeof indexers.$inferSelect;

export type SyncAction = 'new' | 'updated' | 'unchanged' | 'removed';

export interface SyncPreviewItem {
  action: SyncAction;
  name: string;
  type: 'torznab' | 'newznab';
  prowlarrId: number;
  localId?: number;
  changes?: string[];
}

export interface SyncApplyRequest {
  items: Array<{
    prowlarrId: number;
    action: SyncAction;
    selected: boolean;
  }>;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

export class ProwlarrSyncService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  async getConfig(): Promise<ProwlarrConfig | null> {
    const result = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'prowlarr'))
      .limit(1);

    if (result.length === 0) return null;
    return result[0].value as ProwlarrConfig;
  }

  async saveConfig(config: ProwlarrConfig): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: 'prowlarr', value: config as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: config as unknown },
      });
    this.log.info('Prowlarr config saved');
  }

  async testConnection(url: string, apiKey: string): Promise<{ success: boolean; message?: string }> {
    const client = new ProwlarrClient(url, apiKey);
    return client.healthCheck();
  }

  async preview(config: ProwlarrConfig): Promise<SyncPreviewItem[]> {
    const client = new ProwlarrClient(config.url, config.apiKey);

    const remoteIndexers = await client.getIndexers();
    this.log.debug({ count: remoteIndexers.length, names: remoteIndexers.map(i => i.name) }, 'Prowlarr indexers fetched');
    const filtered = client.filterByCategories(remoteIndexers, config.categories);
    this.log.debug({ count: filtered.length, categories: config.categories }, 'Prowlarr indexers after category filter');
    const proxyIndexers = client.buildProxyIndexers(filtered);

    const localProwlarr = await this.db
      .select()
      .from(indexers)
      .where(eq(indexers.source, 'prowlarr'));

    const localBySourceId = new Map<number, IndexerRow>();
    for (const local of localProwlarr) {
      if (local.sourceIndexerId != null) {
        localBySourceId.set(local.sourceIndexerId, local);
      }
    }

    const items: SyncPreviewItem[] = [];
    const seenProwlarrIds = new Set<number>();

    for (const remote of proxyIndexers) {
      seenProwlarrIds.add(remote.prowlarrId);
      const local = localBySourceId.get(remote.prowlarrId);

      if (!local) {
        items.push({
          action: 'new',
          name: remote.name,
          type: remote.type,
          prowlarrId: remote.prowlarrId,
        });
      } else {
        const changes = this.diffIndexer(local, remote);
        if (changes.length > 0 && config.syncMode === 'fullSync') {
          items.push({
            action: 'updated',
            name: remote.name,
            type: remote.type,
            prowlarrId: remote.prowlarrId,
            localId: local.id,
            changes,
          });
        } else {
          items.push({
            action: 'unchanged',
            name: remote.name,
            type: remote.type,
            prowlarrId: remote.prowlarrId,
            localId: local.id,
          });
        }
      }
    }

    if (config.syncMode === 'fullSync') {
      for (const local of localProwlarr) {
        if (local.sourceIndexerId != null && !seenProwlarrIds.has(local.sourceIndexerId)) {
          items.push({
            action: 'removed',
            name: local.name,
            type: local.type as 'torznab' | 'newznab',
            prowlarrId: local.sourceIndexerId,
            localId: local.id,
          });
        }
      }
    }

    this.log.info(
      { new: items.filter(i => i.action === 'new').length, updated: items.filter(i => i.action === 'updated').length, removed: items.filter(i => i.action === 'removed').length },
      'Prowlarr sync preview generated',
    );
    return items;
  }

  async apply(config: ProwlarrConfig, request: SyncApplyRequest): Promise<SyncResult> {
    const client = new ProwlarrClient(config.url, config.apiKey);
    const remoteIndexers = await client.getIndexers();
    const filtered = client.filterByCategories(remoteIndexers, config.categories);
    const proxyIndexers = client.buildProxyIndexers(filtered);
    const proxyByProwlarrId = new Map(proxyIndexers.map(p => [p.prowlarrId, p]));

    const result: SyncResult = { added: 0, updated: 0, removed: 0 };

    for (const item of request.items) {
      if (!item.selected) continue;

      if (item.action === 'new') {
        const proxy = proxyByProwlarrId.get(item.prowlarrId);
        if (!proxy) continue;

        await this.db.insert(indexers).values({
          name: proxy.name,
          type: proxy.type,
          enabled: true,
          priority: 50,
          settings: { apiUrl: proxy.apiUrl, apiKey: proxy.apiKey } as Record<string, unknown>,
          source: 'prowlarr',
          sourceIndexerId: proxy.prowlarrId,
        });
        result.added++;
        this.log.info({ name: proxy.name, prowlarrId: proxy.prowlarrId }, 'Prowlarr indexer imported');
      }

      if (item.action === 'updated') {
        const proxy = proxyByProwlarrId.get(item.prowlarrId);
        if (!proxy) continue;

        const local = await this.db
          .select()
          .from(indexers)
          .where(
            and(
              eq(indexers.source, 'prowlarr'),
              eq(indexers.sourceIndexerId, item.prowlarrId),
            ),
          )
          .limit(1);

        if (local[0]) {
          // Merge Prowlarr-managed fields into existing settings to preserve
          // local-only fields (e.g., flareSolverrUrl) that Prowlarr doesn't manage
          const existingSettings = (local[0].settings as Record<string, unknown>) || {};
          await this.db
            .update(indexers)
            .set({
              name: proxy.name,
              type: proxy.type,
              settings: { ...existingSettings, apiUrl: proxy.apiUrl, apiKey: proxy.apiKey },
            })
            .where(eq(indexers.id, local[0].id));
          result.updated++;
          this.log.info({ name: proxy.name, prowlarrId: proxy.prowlarrId }, 'Prowlarr indexer updated');
        }
      }

      if (item.action === 'removed') {
        const local = await this.db
          .select()
          .from(indexers)
          .where(
            and(
              eq(indexers.source, 'prowlarr'),
              eq(indexers.sourceIndexerId, item.prowlarrId),
            ),
          )
          .limit(1);

        if (local[0]) {
          await this.db.delete(indexers).where(eq(indexers.id, local[0].id));
          result.removed++;
          this.log.info({ name: local[0].name, prowlarrId: item.prowlarrId }, 'Prowlarr indexer removed');
        }
      }
    }

    this.log.info(result, 'Prowlarr sync applied');
    return result;
  }

  private diffIndexer(local: IndexerRow, remote: ProwlarrProxyIndexer): string[] {
    const changes: string[] = [];
    const localSettings = local.settings as Record<string, unknown>;

    if (local.name !== remote.name) changes.push('name');
    if (local.type !== remote.type) changes.push('type');
    if (localSettings.apiUrl !== remote.apiUrl) changes.push('apiUrl');
    if (localSettings.apiKey !== remote.apiKey) changes.push('apiKey');

    return changes;
  }
}
