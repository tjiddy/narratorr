import { eq, desc, inArray, and } from 'drizzle-orm';
import { type Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '@narratorr/db/schema';
import { parseInfoHash, type DownloadProtocol } from '@narratorr/core';
import { type DownloadClientService } from './download-client.service.js';

type DownloadRow = typeof downloads.$inferSelect;
type BookRow = typeof books.$inferSelect;

export interface DownloadWithBook extends DownloadRow {
  book?: BookRow;
}

export class DownloadService {
  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private log: FastifyBaseLogger
  ) {}

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

  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol;
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
  }): Promise<DownloadWithBook> {
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
    this.log.debug({ protocol, downloadUrl: params.downloadUrl, infoHash, clientId: client.id, clientName: client.name }, 'Sending download to client');
    const externalId = await adapter.addDownload(params.downloadUrl);

    if (!externalId) {
      this.log.warn({ title: params.title, downloadUrl: params.downloadUrl }, 'Download client returned no external ID');
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
        status: 'downloading',
        externalId,
      })
      .returning();

    // Update book status if linked
    if (params.bookId) {
      await this.db
        .update(books)
        .set({ status: 'downloading', updatedAt: new Date() })
        .where(eq(books.id, params.bookId));
    }

    this.log.info({ title: params.title, indexerId: params.indexerId }, 'Download initiated');
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

    // Reset book status if linked
    if (download.bookId) {
      await this.db
        .update(books)
        .set({ status: 'wanted', updatedAt: new Date() })
        .where(eq(books.id, download.bookId));
    }

    this.log.info({ id }, 'Download cancelled');
    return true;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(downloads).where(eq(downloads.id, id));
    return true;
  }
}
