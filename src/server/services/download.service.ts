import { eq, desc, inArray, and, count, sql } from 'drizzle-orm';
import { type Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { parseInfoHash, type DownloadProtocol } from '../../core/index.js';
import { type DownloadClientService } from './download-client.service.js';
import { type NotifierService } from './notifier.service.js';
import { type EventHistoryService, type CreateEventInput } from './event-history.service.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';

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
  private emitEventForGrab(bookId: number | undefined, title: string, downloadId: number, reason?: Record<string, unknown>): void {
    if (bookId) {
      this.emitEvent({ bookId, bookTitle: title, downloadId, eventType: 'grabbed', source: 'auto', reason });
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

  async getAll(status?: string): Promise<DownloadWithBook[]> {
    let query = this.db
      .select({
        download: downloads,
        book: books,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .orderBy(desc(downloads.addedAt));

    if (status) {
      query = query.where(
        eq(downloads.status, status as DownloadRow['status'])
      ) as typeof query;
    }

    const results = await query;

    return results.map((r) => ({
      ...r.download,
      book: r.book || undefined,
    }));
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
    const activeStatuses: DownloadRow['status'][] = [
      'queued',
      'downloading',
      'paused',
      'importing',
    ];

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
    const activeStatuses: DownloadRow['status'][] = [
      'queued', 'downloading', 'paused', 'importing',
    ];
    const completedStatuses: DownloadRow['status'][] = [
      'completed', 'imported',
    ];

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
    const activeStatuses: DownloadRow['status'][] = [
      'queued',
      'downloading',
      'paused',
      'importing',
    ];

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
  }): Promise<DownloadWithBook> {
    // Check for existing active downloads for this book
    if (params.bookId && !params.skipDuplicateCheck) {
      const active = await this.getActiveByBookId(params.bookId);
      if (active.length > 0) {
        throw new Error(`Book ${params.bookId} already has an active download (id: ${active[0].id})`);
      }
    }

    const protocol = params.protocol ?? 'torrent';
    const infoHash = protocol === 'torrent' ? parseInfoHash(params.downloadUrl) : null;

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
    this.log.debug({ protocol, downloadUrl: params.downloadUrl, infoHash, clientId: client.id, clientName: client.name, category }, 'Sending download to client');
    const externalId = await adapter.addDownload(params.downloadUrl, category ? { category } : undefined);

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
    });

    return this.getById(result[0].id) as Promise<DownloadWithBook>;
  }

  async updateProgress(id: number, progress: number): Promise<void> {
    const status: DownloadRow['status'] = progress >= 1 ? 'completed' : 'downloading';
    const completedAt = progress >= 1 ? new Date() : null;

    await this.db
      .update(downloads)
      .set({ progress, status, completedAt })
      .where(eq(downloads.id, id));

    if (progress >= 1) {
      this.log.info({ id }, 'Download completed');

      // Record download_completed event (fire-and-forget)
      this.emitEventForDownload(id, 'download_completed', { progress: 1 });
    }
  }

  async updateStatus(id: number, status: DownloadRow['status']): Promise<void> {
    await this.db.update(downloads).set({ status }).where(eq(downloads.id, id));
    this.log.info({ id, status }, 'Download status changed');
  }

  async setError(id: number, errorMessage: string): Promise<void> {
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage })
      .where(eq(downloads.id, id));
    this.log.warn({ id, error: errorMessage }, 'Download error recorded');

    // Record download_failed event (fire-and-forget)
    this.emitEventForDownload(id, 'download_failed', { error: errorMessage });
  }

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
    await this.db
      .update(downloads)
      .set({ status: 'failed', errorMessage: 'Cancelled by user' })
      .where(eq(downloads.id, id));

    // Reset book status if linked — revert to imported if book has a path, else wanted
    if (download.bookId) {
      const revertStatus = download.book?.path ? 'imported' : 'wanted';
      await this.db
        .update(books)
        .set({ status: revertStatus, updatedAt: new Date() })
        .where(eq(books.id, download.bookId));
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
