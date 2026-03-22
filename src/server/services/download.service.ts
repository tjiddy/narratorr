import { eq, desc, inArray, and, count, sql } from 'drizzle-orm';
import { type Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, indexers } from '../../db/schema.js';
import { parseInfoHash, type DownloadProtocol } from '../../core/index.js';
import { getInProgressStatuses, getTerminalStatuses, getCompletedStatuses, isTerminalStatus, getReplacableStatuses } from '../../shared/download-status-registry.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import { type DownloadClientService } from './download-client.service.js';
import { type CreateEventInput } from './event-history.service.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';

import type { DownloadRow } from './types.js';

type BookRow = typeof books.$inferSelect;
type IndexerRow = typeof indexers.$inferSelect;

export interface DownloadWithBook extends DownloadRow {
  book?: BookRow;
  indexerName: string | null;
}

export type RetryResult =
  | { status: 'retried'; download: DownloadWithBook }
  | { status: 'no_candidates' }
  | { status: 'retry_error'; error: string };

export class DownloadService {
  private retrySearchDeps?: RetrySearchDeps;

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private log: FastifyBaseLogger,
  ) {}

  /** Set retry search dependencies (called after service graph construction). */
  setRetrySearchDeps(deps: RetrySearchDeps): void {
    this.retrySearchDeps = deps;
  }

  async getAll(
    status?: string,
    pagination?: { limit?: number; offset?: number },
    section?: 'queue' | 'history',
  ): Promise<{ data: DownloadWithBook[]; total: number }> {
    let where;
    if (section === 'queue') {
      where = inArray(downloads.status, getInProgressStatuses());
    } else if (section === 'history') {
      where = inArray(downloads.status, getTerminalStatuses());
    } else if (status) {
      where = eq(downloads.status, status as DownloadRow['status']);
    }

    // Get total count (with filters, before pagination)
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(downloads)
      .where(where);

    // Get data with optional pagination
    let query = this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(where)
      .orderBy(desc(downloads.addedAt), desc(downloads.id));

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const results = await query;

    const data = results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
      indexerName: r.indexer?.name ?? null,
    }));

    return { data, total };
  }

  async getById(id: number): Promise<DownloadWithBook | null> {
    const results = await this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(eq(downloads.id, id))
      .limit(1);

    if (results.length === 0) return null;

    return {
      ...results[0].download,
      book: results[0].book || undefined,
      indexerName: results[0].indexer?.name ?? null,
    };
  }

  async getActive(): Promise<DownloadWithBook[]> {
    const activeStatuses = getInProgressStatuses();

    const results = await this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(inArray(downloads.status, activeStatuses))
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
      indexerName: r.indexer?.name ?? null,
    }));
  }

  async getCounts(): Promise<{ active: number; completed: number }> {
    const activeStatuses = getInProgressStatuses();
    const completedStatuses = getCompletedStatuses();

    const rows = await this.db
      .select({
        isActive: sql<number>`CASE WHEN ${downloads.status} IN (${sql.join(activeStatuses.map(s => sql`${s}`), sql`, `)}) THEN 1 ELSE 0 END`,
        cnt: count(),
      })
      .from(downloads)
      .where(inArray(downloads.status, [...activeStatuses, ...completedStatuses]))
      .groupBy(sql`1`);

    let active = 0;
    let completed = 0;
    for (const row of rows) {
      if (Number(row.isActive) === 1) active = Number(row.cnt);
      else completed = Number(row.cnt);
    }

    return { active, completed };
  }

  async getActiveByBookId(bookId: number): Promise<DownloadWithBook[]> {
    const activeStatuses = getInProgressStatuses();

    const results = await this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(and(
        inArray(downloads.status, activeStatuses),
        eq(downloads.bookId, bookId),
      ))
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
      indexerName: r.indexer?.name ?? null,
    }));
  }

  /** Send a download to the client and return the external ID. */
  private async sendToClient(downloadUrl: string, protocol: DownloadProtocol, torrentFile?: Buffer): Promise<{ externalId: string | null; clientId: number; clientType: string }> {
    const client = await this.downloadClientService.getFirstEnabledForProtocol(protocol);
    if (!client) throw new Error('No download client configured');
    const adapter = await this.downloadClientService.getAdapter(client.id);
    if (!adapter) throw new Error('Could not initialize download client');
    const settings = (client.settings ?? {}) as Record<string, unknown>;
    const category = (settings.category as string | undefined)?.trim() || undefined;
    const addOptions = { ...(category ? { category } : {}), ...(torrentFile ? { torrentFile } : {}) };
    const externalId = await adapter.addDownload(downloadUrl, Object.keys(addOptions).length > 0 ? addOptions : undefined);
    return { externalId, clientId: client.id, clientType: client.type };
  }

  /** Parse data: URI torrent files into a buffer + metadata. */
  private parseDownloadInput(downloadUrl: string, protocol: DownloadProtocol): { torrentFile?: Buffer; infoHash: string | null; logUrl: string } {
    const isDataUri = downloadUrl.startsWith('data:application/x-bittorrent;base64,');
    if (isDataUri) {
      const base64Content = downloadUrl.slice('data:application/x-bittorrent;base64,'.length);
      const torrentFile = Buffer.from(base64Content, 'base64');
      return { torrentFile, infoHash: null, logUrl: `data:application/x-bittorrent [${(torrentFile.length / 1024).toFixed(1)} KB]` };
    }
    const infoHash = protocol === 'torrent' ? parseInfoHash(downloadUrl) : null;
    return { infoHash, logUrl: downloadUrl };
  }

  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol;
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
    skipDuplicateCheck?: boolean;
    replaceExisting?: boolean;
    source?: CreateEventInput['source'];
  }): Promise<DownloadWithBook> {
    // Check for active downloads for this book
    if (params.bookId && !params.skipDuplicateCheck) {
      const allActive = await this.getActiveByBookId(params.bookId);
      const replaceableSet = new Set<string>(getReplacableStatuses());
      const replaceableActive = allActive.filter((dl) => replaceableSet.has(dl.status));

      if (replaceableActive.length > 0) {
        if (params.replaceExisting) {
          // Cancel each replaceable active download (best-effort: proceed even if cancel fails)
          for (const dl of replaceableActive) {
            try {
              await this.cancel(dl.id, 'Replaced by new download');
            } catch (cancelErr) {
              this.log.warn({ id: dl.id, error: cancelErr }, 'Failed to cancel replaceable download — proceeding with replacement anyway');
            }
          }
          // Revert book status to wanted so a failed grab leaves the book in a recoverable state
          await this.db.update(books).set({ status: 'wanted' }).where(eq(books.id, params.bookId));
        } else {
          const err = new Error(`Book ${params.bookId} already has an active download (id: ${replaceableActive[0].id})`);
          (err as Error & { code: string }).code = 'ACTIVE_DOWNLOAD_EXISTS';
          throw err;
        }
      } else {
        // No replaceable downloads — apply existing duplicate-check for import-pipeline statuses
        // (processing_queued/importing are not replaceable but still block grabs)
        const pipelineActive = allActive.filter((dl) => !replaceableSet.has(dl.status));
        if (pipelineActive.length > 0) {
          throw new Error(`Book ${params.bookId} already has an active download (id: ${pipelineActive[0].id})`);
        }
      }
    }

    const protocol = params.protocol ?? 'torrent';
    const { torrentFile, infoHash, logUrl } = this.parseDownloadInput(params.downloadUrl, protocol);

    // Send to download client
    this.log.debug({ protocol, downloadUrl: logUrl, infoHash }, 'Sending download to client');
    const { externalId, clientId, clientType } = await this.sendToClient(params.downloadUrl, protocol, torrentFile);

    // Handoff clients (e.g. Blackhole) return null externalId — mark as completed immediately
    const isHandoff = !externalId;
    const downloadStatus = isHandoff ? 'completed' as const : 'downloading' as const;
    const downloadProgress = isHandoff ? 1 : 0;
    const downloadCompletedAt = isHandoff ? new Date() : undefined;
    if (isHandoff) {
      this.log.info({ title: params.title, clientType }, 'Handoff client — download completed immediately (no progress tracking)');
    }

    // Create download record
    const result = await this.db
      .insert(downloads)
      .values({
        bookId: params.bookId,
        indexerId: params.indexerId,
        downloadClientId: clientId,
        title: params.title,
        protocol,
        infoHash,
        downloadUrl: params.downloadUrl,
        size: params.size,
        seeders: params.seeders,
        status: downloadStatus,
        progress: downloadProgress,
        completedAt: downloadCompletedAt,
        externalId: externalId ?? undefined,
      })
      .returning();

    this.log.info({ title: params.title, indexerId: params.indexerId }, 'Download initiated');

    return this.getById(result[0].id) as Promise<DownloadWithBook>;
  }

  async updateProgress(id: number, progress: number, _bookId?: number): Promise<void> {
    const status: DownloadStatus = progress >= 1 ? 'completed' : 'downloading';
    const completedAt = progress >= 1 ? new Date() : null;

    // Only update progressUpdatedAt when progress actually changes (for stuck download detection)
    const existing = await this.db.select({ progress: downloads.progress }).from(downloads).where(eq(downloads.id, id));
    const progressChanged = !existing[0] || existing[0].progress !== progress;

    await this.db
      .update(downloads)
      .set({ progress, status, completedAt, ...(progressChanged ? { progressUpdatedAt: new Date() } : {}) })
      .where(eq(downloads.id, id));

    if (progress >= 1) {
      this.log.info({ id }, 'Download completed');
    }
  }

  async updateStatus(id: number, status: DownloadRow['status'], _meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.db.update(downloads).set({ status }).where(eq(downloads.id, id));
    this.log.info({ id, status }, 'Download status changed');
  }

  async setError(id: number, errorMessage: string, _meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage })
      .where(eq(downloads.id, id));
    this.log.warn({ id, error: errorMessage }, 'Download error recorded');
  }

  async cancel(id: number, reason = 'Cancelled by user'): Promise<boolean> {
    const download = await this.getById(id);
    if (!download) return false;

    // Remove from download client if possible
    if (download.downloadClientId && download.externalId) {
      try {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        if (adapter) {
          await adapter.removeDownload(download.externalId, true);
        }
      } catch (error) {
        this.log.error({ error, id }, 'Failed to remove download from client');
      }
    }

    // Update download status
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage: reason })
      .where(eq(downloads.id, id));

    this.log.info({ id }, 'Download cancelled');
    return true;
  }

  async retry(id: number): Promise<RetryResult> {
    const download = await this.getById(id);
    if (!download) throw new Error(`Download ${id} not found`);
    if (download.status !== 'failed') throw new Error(`Download ${id} is not in failed state`);
    if (!download.bookId) throw new Error(`Download ${id} has no book linked`);

    if (!this.retrySearchDeps) {
      throw new Error('Retry search dependencies not configured');
    }

    // Reset retry counter for this book (manual retry = new cycle)
    this.retrySearchDeps.retryBudget.reset(download.bookId);

    const result = await retrySearch(download.bookId, this.retrySearchDeps);

    switch (result.outcome) {
      case 'retried': {
        // Delete the old failed download record
        try {
          await this.db.delete(downloads).where(eq(downloads.id, id));
        } catch (error) {
          this.log.warn({ oldId: id, newId: result.download.id, error }, 'Failed to delete old download record after retry');
        }
        this.log.info({ oldId: id, newId: result.download.id }, 'Download retried');
        return { status: 'retried', download: result.download };
      }
      case 'no_candidates':
      case 'exhausted': {
        await this.db.update(downloads).set({ errorMessage: 'No viable candidates' }).where(eq(downloads.id, id));
        this.log.info({ id }, 'Manual retry found no candidates');
        return { status: 'no_candidates' };
      }
      case 'retry_error': {
        await this.db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, id));
        this.log.warn({ id, error: result.error }, 'Manual retry search failed');
        return { status: 'retry_error', error: result.error };
      }
    }
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    if (!isTerminalStatus(existing.status)) {
      throw new Error(`Cannot delete download with status '${existing.status}' — use cancel instead`);
    }

    await this.db.delete(downloads).where(eq(downloads.id, id));
    this.log.info({ id }, 'Download history item deleted');
    return true;
  }

  async deleteHistory(): Promise<{ deleted: number }> {
    const terminalStatuses = getTerminalStatuses();
    const rows = await this.db
      .delete(downloads)
      .where(inArray(downloads.status, terminalStatuses))
      .returning({ id: downloads.id });
    const deleted = rows.length;
    this.log.info({ deleted }, 'Download history bulk deleted');
    return { deleted };
  }
}
