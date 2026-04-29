import { eq, desc, inArray, and, count, sql } from 'drizzle-orm';
import { type Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, indexers, importJobs } from '../../db/schema.js';
import type { DownloadProtocol } from '../../core/index.js';
import { DownloadUrl } from '../../core/utils/download-url.js';
import type { DownloadArtifact } from '../../core/download-clients/types.js';
import { getInProgressStatuses, getTerminalStatuses, getCompletedStatuses, isTerminalStatus, getReplaceableStatuses } from '../../shared/download-status-registry.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus, EnrichmentStatus } from '../../shared/schemas/book.js';
import { type DownloadClientService } from './download-client.service.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import { type CreateEventInput } from './event-history.service.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';
import { WireOnce } from './wire-helpers.js';

import type { DownloadRow } from './types.js';
import { serializeError } from '../utils/serialize-error.js';


// $inferSelect widens enum columns to bare `string` (CLAUDE.md gotcha) — re-narrow.
type BookRow = Omit<typeof books.$inferSelect, 'status' | 'enrichmentStatus'> & {
  status: BookStatus;
  enrichmentStatus: EnrichmentStatus;
};

export interface DownloadWithBook extends DownloadRow {
  book?: BookRow;
  indexerName: string | null;
}

export type RetryResult =
  | { status: 'retried'; download: DownloadWithBook }
  | { status: 'no_candidates' }
  | { status: 'retry_error'; error: string };

export class DownloadError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS' | 'NO_BOOK_LINKED',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export class DuplicateDownloadError extends Error {
  constructor(
    message: string,
    public code: 'ACTIVE_DOWNLOAD_EXISTS' | 'PIPELINE_ACTIVE',
  ) {
    super(message);
    this.name = 'DuplicateDownloadError';
  }
}

export interface DownloadServiceWireDeps {
  retrySearchDeps: RetrySearchDeps;
}

export class DownloadService {
  private wired = new WireOnce<DownloadServiceWireDeps>('DownloadService');

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private log: FastifyBaseLogger,
  ) {}

  /** Wire cyclic / late-bound deps after construction. Call once during composition. */
  wire(deps: DownloadServiceWireDeps): void {
    this.wired.set(deps);
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

  /** Send a pre-resolved artifact to the client and return the external ID. */
  private async sendToClient(artifact: DownloadArtifact, protocol: DownloadProtocol): Promise<{ externalId: string | null; clientId: number; clientType: string; clientName: string }> {
    const client = await this.downloadClientService.getFirstEnabledForProtocol(protocol);
    if (!client) throw new Error('No download client configured');
    const adapter = await this.downloadClientService.getAdapter(client.id);
    if (!adapter) throw new Error('Could not initialize download client');
    const settings = (client.settings ?? {}) as Record<string, unknown>;
    const category = (settings.category as string | undefined)?.trim() || undefined;
    const addOptions = { ...(category ? { category } : {}) };
    const externalId = await adapter.addDownload(artifact, Object.keys(addOptions).length > 0 ? addOptions : undefined);
    return { externalId, clientId: client.id, clientType: client.type, clientName: client.name };
  }

  private async checkDuplicateDownloads(bookId: number, replaceExisting?: boolean): Promise<void> {
    const allActive = await this.getActiveByBookId(bookId);
    const replaceableSet = new Set<string>(getReplaceableStatuses());
    const replaceableActive = allActive.filter((dl) => replaceableSet.has(dl.status));

    if (replaceableActive.length > 0) {
      if (replaceExisting) {
        for (const dl of replaceableActive) {
          try {
            await this.cancel(dl.id, 'Replaced by new download');
          } catch (cancelErr: unknown) {
            this.log.warn({ id: dl.id, error: serializeError(cancelErr) }, 'Failed to cancel replaceable download — proceeding with replacement anyway');
          }
        }
        await this.db.update(books).set({ status: 'wanted' }).where(eq(books.id, bookId));
      } else {
        throw new DuplicateDownloadError(`Book ${bookId} already has an active download (id: ${replaceableActive[0].id})`, 'ACTIVE_DOWNLOAD_EXISTS');
      }
    } else {
      const pipelineActive = allActive.filter((dl) => !replaceableSet.has(dl.status));
      if (pipelineActive.length > 0) {
        throw new DuplicateDownloadError(`Book ${bookId} already has an active download (id: ${pipelineActive[0].id})`, 'PIPELINE_ACTIVE');
      }

      // Guard the window where the download is already `completed` (terminal,
      // so filtered out above) but an auto import_jobs row is pending/processing.
      const pendingAutoJobs = await this.db
        .select({ id: importJobs.id })
        .from(importJobs)
        .where(and(
          eq(importJobs.bookId, bookId),
          eq(importJobs.type, 'auto'),
          inArray(importJobs.status, ['pending', 'processing']),
        ))
        .limit(1);
      if (pendingAutoJobs.length > 0) {
        throw new DuplicateDownloadError(`Book ${bookId} already has an active auto import job (id: ${pendingAutoJobs[0].id})`, 'PIPELINE_ACTIVE');
      }
    }
  }

  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol;
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
    guid?: string;
    skipDuplicateCheck?: boolean;
    replaceExisting?: boolean;
    source?: CreateEventInput['source'];
  }): Promise<DownloadWithBook> {
    if (params.bookId && !params.skipDuplicateCheck) {
      await this.checkDuplicateDownloads(params.bookId, params.replaceExisting);
    }

    const protocol = params.protocol ?? 'torrent';

    // Resolve the download URL into a typed artifact
    const downloadUrlObj = new DownloadUrl(params.downloadUrl, protocol);
    const artifact = await downloadUrlObj.resolve();

    // Extract info hash from artifact (torrent-bytes and magnet-uri have it; nzb-url does not)
    const infoHash = 'infoHash' in artifact ? artifact.infoHash : null;
    const logUrl = sanitizeLogUrl(params.downloadUrl);

    // Send to download client
    this.log.debug({ protocol, downloadUrl: logUrl, infoHash }, 'Sending download to client');
    const { externalId, clientId, clientType, clientName } = await this.sendToClient(artifact, protocol);
    this.log.debug({ externalId, clientName, bookId: params.bookId }, 'Download sent to client');

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
        guid: params.guid,
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
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error), id }, 'Failed to remove download from client');
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
    if (!download) throw new DownloadError(`Download ${id} not found`, 'NOT_FOUND');
    if (download.status !== 'failed') throw new DownloadError(`Download ${id} is not in failed state`, 'INVALID_STATUS');
    if (!download.bookId) throw new DownloadError(`Download ${id} has no book linked`, 'NO_BOOK_LINKED');

    const { retrySearchDeps } = this.wired.require();

    // Reset retry counter for this book (manual retry = new cycle)
    retrySearchDeps.retryBudget.reset(download.bookId);

    const result = await retrySearch(download.bookId, retrySearchDeps);

    switch (result.outcome) {
      case 'retried': {
        // Delete the old failed download record
        try {
          await this.db.delete(downloads).where(eq(downloads.id, id));
        } catch (error: unknown) {
          this.log.warn({ oldId: id, newId: result.download.id, error: serializeError(error) }, 'Failed to delete old download record after retry');
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
      throw new DownloadError(`Cannot delete download with status '${existing.status}' — use cancel instead`, 'INVALID_STATUS');
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
