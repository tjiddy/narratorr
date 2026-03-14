import { eq, desc, inArray, and, count, sql } from 'drizzle-orm';
import { type Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { parseInfoHash, type DownloadProtocol } from '../../core/index.js';
import { getInProgressStatuses, getCompletedStatuses } from '../../shared/download-status-registry.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import { type DownloadClientService } from './download-client.service.js';
import { type NotifierService } from './notifier.service.js';
import { type EventHistoryService, type CreateEventInput } from './event-history.service.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';
import { type EventBroadcasterService } from './event-broadcaster.service.js';

type DownloadRow = typeof downloads.$inferSelect;
type BookRow = typeof books.$inferSelect;

export interface DownloadWithBook extends DownloadRow {
  book?: BookRow;
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
    private notifierService?: NotifierService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
  ) {}

  /** Set retry search dependencies (called after service graph construction). */
  setRetrySearchDeps(deps: RetrySearchDeps): void {
    this.retrySearchDeps = deps;
  }

  /** Fire-and-forget event recording — silently skips if no eventHistory injected. */
  private emitEvent(input: CreateEventInput): void {
    this.eventHistory?.create(input)
      .catch((err) => this.log.warn(err, `Failed to record ${input.eventType} event`));
  }

  /** Emit grabbed event if bookId is present (fire-and-forget). */
  private emitEventForGrab(bookId: number | undefined, title: string, downloadId: number, reason?: Record<string, unknown>, source: CreateEventInput['source'] = 'auto'): void {
    if (bookId) {
      this.emitEvent({ bookId, bookTitle: title, downloadId, eventType: 'grabbed', source, reason });
    }
  }

  /** Look up a download and emit an event for it (fire-and-forget). */
  private emitEventForDownload(downloadId: number, eventType: CreateEventInput['eventType'], reason?: Record<string, unknown>): void {
    if (!this.eventHistory) return;
    this.getById(downloadId).then((dl) => {
      if (dl?.bookId) {
        this.emitEvent({ bookId: dl.bookId, bookTitle: dl.title, downloadId: dl.id, eventType, source: 'auto', reason });
      }
    }).catch((err) => this.log.warn(err, 'Failed to look up download for event'));
  }

  async getAll(
    status?: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<{ data: DownloadWithBook[]; total: number }> {
    const where = status
      ? eq(downloads.status, status as DownloadRow['status'])
      : undefined;

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
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
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
    }));

    return { data, total };
  }

  async getById(id: number): Promise<DownloadWithBook | null> {
    const results = await this.db
      .select({
        download: downloads,
        book: books,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(eq(downloads.id, id))
      .limit(1);

    if (results.length === 0) return null;

    return {
      ...results[0].download,
      book: results[0].book || undefined,
    };
  }

  async getActive(): Promise<DownloadWithBook[]> {
    const activeStatuses = getInProgressStatuses();

    const results = await this.db
      .select({
        download: downloads,
        book: books,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(inArray(downloads.status, activeStatuses))
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
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
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(and(
        inArray(downloads.status, activeStatuses),
        eq(downloads.bookId, bookId),
      ))
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
    }));
  }

  // eslint-disable-next-line complexity -- linear grab flow with per-field conditionals for handoff vs tracked clients
  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol;
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
    skipDuplicateCheck?: boolean;
    source?: CreateEventInput['source'];
  }): Promise<DownloadWithBook> {
    // Check for existing active downloads for this book
    if (params.bookId && !params.skipDuplicateCheck) {
      const active = await this.getActiveByBookId(params.bookId);
      if (active.length > 0) {
        throw new Error(`Book ${params.bookId} already has an active download (id: ${active[0].id})`);
      }
    }

    const protocol = params.protocol ?? 'torrent';

    // Detect data: URI torrent files — decode base64 content for torrent file handoff
    const isDataUri = params.downloadUrl.startsWith('data:application/x-bittorrent;base64,');
    let torrentFile: Buffer | undefined;
    if (isDataUri) {
      const base64Content = params.downloadUrl.slice('data:application/x-bittorrent;base64,'.length);
      torrentFile = Buffer.from(base64Content, 'base64');
    }

    const infoHash = protocol === 'torrent' && !isDataUri ? parseInfoHash(params.downloadUrl) : null;

    // Get the first enabled download client for this protocol
    const client = await this.downloadClientService.getFirstEnabledForProtocol(protocol);
    if (!client) {
      throw new Error('No download client configured');
    }

    const adapter = await this.downloadClientService.getAdapter(client.id);
    if (!adapter) {
      throw new Error('Could not initialize download client');
    }

    // Add to download client
    const settings = (client.settings ?? {}) as Record<string, unknown>;
    const category = (settings.category as string | undefined)?.trim() || undefined;
    const logUrl = isDataUri ? `data:application/x-bittorrent [${(torrentFile!.length / 1024).toFixed(1)} KB]` : params.downloadUrl;
    this.log.debug({ protocol, downloadUrl: logUrl, infoHash, clientId: client.id, clientName: client.name, category }, 'Sending download to client');
    const addOptions = { ...(category ? { category } : {}), ...(torrentFile ? { torrentFile } : {}) };
    const externalId = await adapter.addDownload(params.downloadUrl, Object.keys(addOptions).length > 0 ? addOptions : undefined);

    // Handoff clients (e.g. Blackhole) return null externalId — mark as completed immediately
    const isHandoff = !externalId;
    const downloadStatus = isHandoff ? 'completed' as const : 'downloading' as const;
    const downloadProgress = isHandoff ? 1 : 0;
    const downloadCompletedAt = isHandoff ? new Date() : undefined;
    if (isHandoff) {
      this.log.info({ title: params.title, clientType: client.type }, 'Handoff client — download completed immediately (no progress tracking)');
    }

    // Create download record
    const result = await this.db
      .insert(downloads)
      .values({
        bookId: params.bookId,
        indexerId: params.indexerId,
        downloadClientId: client.id,
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

    // Update book status if linked
    if (params.bookId) {
      const bookStatus = isHandoff ? 'missing' as const : 'downloading' as const;
      await this.db
        .update(books)
        .set({ status: bookStatus, updatedAt: new Date() })
        .where(eq(books.id, params.bookId));
    }

    this.log.info({ title: params.title, indexerId: params.indexerId }, 'Download initiated');

    // Fire grab notification (fire-and-forget)
    if (this.notifierService) {
      Promise.resolve(this.notifierService.notify('on_grab', {
        event: 'on_grab',
        book: { title: params.title },
        release: { title: params.title, size: params.size },
      })).catch((err) => this.log.warn(err, 'Failed to send grab notification'));
    }

    // Record grabbed event (fire-and-forget)
    this.emitEventForGrab(params.bookId, params.title, result[0].id, {
      indexerId: params.indexerId,
      size: params.size,
      protocol,
    }, params.source);

    // SSE: grab_started
    if (params.bookId) {
      try {
        this.broadcaster?.emit('grab_started', {
          download_id: result[0].id, book_id: params.bookId, book_title: params.title, release_title: params.title,
        });
        // SSE: book_status_change (wanted -> downloading or missing for handoff)
        const bookStatus = isHandoff ? 'missing' as const : 'downloading' as const;
        this.broadcaster?.emit('book_status_change', {
          book_id: params.bookId, old_status: 'wanted', new_status: bookStatus,
        });
      } catch { /* fire-and-forget */ }
    }

    return this.getById(result[0].id) as Promise<DownloadWithBook>;
  }

  async updateProgress(id: number, progress: number, bookId?: number): Promise<void> {
    const oldStatus: DownloadStatus = 'downloading';
    const status: DownloadStatus = progress >= 1 ? 'completed' : 'downloading';
    const completedAt = progress >= 1 ? new Date() : null;

    // Only update progressUpdatedAt when progress actually changes (for stuck download detection)
    const existing = await this.db.select({ progress: downloads.progress }).from(downloads).where(eq(downloads.id, id));
    const progressChanged = !existing[0] || existing[0].progress !== progress;

    await this.db
      .update(downloads)
      .set({ progress, status, completedAt, ...(progressChanged ? { progressUpdatedAt: new Date() } : {}) })
      .where(eq(downloads.id, id));

    // SSE: download_progress (always emit if we have a broadcaster)
    if (bookId) {
      try { this.broadcaster?.emit('download_progress', { download_id: id, book_id: bookId, percentage: progress, speed: null, eta: null }); } catch { /* fire-and-forget */ }
    }

    if (progress >= 1) {
      this.log.info({ id }, 'Download completed');

      // SSE: download_status_change
      if (bookId) {
        try { this.broadcaster?.emit('download_status_change', { download_id: id, book_id: bookId, old_status: oldStatus, new_status: status }); } catch { /* fire-and-forget */ }
      }

      // Record download_completed event (fire-and-forget)
      this.emitEventForDownload(id, 'download_completed', { progress: 1 });
    }
  }

  async updateStatus(id: number, status: DownloadRow['status'], meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.db.update(downloads).set({ status }).where(eq(downloads.id, id));
    this.log.info({ id, status }, 'Download status changed');

    // SSE: download_status_change
    if (meta?.bookId && meta?.oldStatus) {
      try { this.broadcaster?.emit('download_status_change', { download_id: id, book_id: meta.bookId, old_status: meta.oldStatus, new_status: status as DownloadStatus }); } catch { /* fire-and-forget */ }
    }
  }

  async setError(id: number, errorMessage: string, meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage })
      .where(eq(downloads.id, id));
    this.log.warn({ id, error: errorMessage }, 'Download error recorded');

    // SSE: download_status_change
    if (meta?.bookId && meta?.oldStatus) {
      try { this.broadcaster?.emit('download_status_change', { download_id: id, book_id: meta.bookId, old_status: meta.oldStatus, new_status: 'failed' }); } catch { /* fire-and-forget */ }
    }

    // Record download_failed event (fire-and-forget)
    this.emitEventForDownload(id, 'download_failed', { error: errorMessage });
  }

  // eslint-disable-next-line complexity -- linear cancel flow with SSE emission at each status transition
  async cancel(id: number): Promise<boolean> {
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
    const oldStatus = download.status as DownloadStatus;
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage: 'Cancelled by user' })
      .where(eq(downloads.id, id));

    // SSE: download_status_change
    if (download.bookId) {
      try { this.broadcaster?.emit('download_status_change', { download_id: id, book_id: download.bookId, old_status: oldStatus, new_status: 'failed' }); } catch { /* fire-and-forget */ }
    }

    // Reset book status if linked — revert to imported if book has a path, else wanted
    if (download.bookId) {
      const oldBookStatus = (download.book?.status ?? 'downloading') as BookStatus;
      const revertStatus: BookStatus = download.book?.path ? 'imported' : 'wanted';
      await this.db
        .update(books)
        .set({ status: revertStatus, updatedAt: new Date() })
        .where(eq(books.id, download.bookId));

      // SSE: book_status_change
      try { this.broadcaster?.emit('book_status_change', { book_id: download.bookId, old_status: oldBookStatus, new_status: revertStatus }); } catch { /* fire-and-forget */ }
    }

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

    await this.db.delete(downloads).where(eq(downloads.id, id));
    return true;
  }
}
