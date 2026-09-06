import { eq, desc, and, or, count, sql } from 'drizzle-orm';
import { type Db, type DbOrTx } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, indexers } from '@db/schema.js';
import type { DownloadProtocol } from '@core/index.js';
import type { DownloadArtifact, StagedHandoff } from '@core/download-clients/types.js';
import { isTerminalState, deriveDisplayStatus } from '@shared/download-status-registry.js';
import { clientCategory } from '@shared/schemas/download-client.js';
import {
  inProgressDownloadCondition,
  terminalDownloadCondition,
  completedCountDownloadCondition,
  displayStatusCondition,
  transitionDownloadState,
} from '../utils/download-state.js';
import type { ClientStatus, DownloadStatus } from '@shared/schemas/activity.js';
import { type DownloadClientService } from './download-client.service.js';
import type { IndexerService } from './indexer.service.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import { type CreateEventInput } from './event-history.service.js';
import { retrySearch, RETRY_ERROR_MESSAGE, type RetrySearchDeps } from './retry-search.js';
import { WireOnce } from './wire-helpers.js';
import { resolveAdapterDownloadUrl } from './download-resolve-adapter-url.js';
import { resolveArtifact, insertDownloadRecordOrCompensate } from './download-record.js';
import { gatherBookBlockers, classifyBlockers } from './download-blockers.js';

import type { BookRowPublic, DownloadRow } from './types.js';
import { stripClearedFields } from './book-row-public.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { serializeError } from '../utils/serialize-error.js';
import { applyPagination } from '../utils/db-helpers.js';
import { DownloadError, DuplicateDownloadError } from './download-errors.js';

export interface DownloadWithBook extends DownloadRow {
  /** Derived REST/SSE/client compatibility status. */
  status: DownloadStatus;
  /** BookRowPublic, not BookRow: unschematized responses copy joined rows wholesale, so strip raw user_cleared_fields here. */
  book?: BookRowPublic;
  indexerName: string | null;
}

export type RetryResult =
  | { status: 'retried'; download: DownloadWithBook }
  | { status: 'no_candidates' }
  | { status: 'already_active' }
  | { status: 'retry_error'; error: string };

// Compatibility re-export preserves existing import paths and instanceof identity.
export { DownloadError, DuplicateDownloadError };

export interface DownloadServiceWireDeps {
  retrySearchDeps: RetrySearchDeps;
  indexerService: IndexerService;
}

export class DownloadService {
  private wired = new WireOnce<DownloadServiceWireDeps>('DownloadService');

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private log: FastifyBaseLogger,
  ) {}

  /** Wire cyclic dependencies once during composition. */
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
      where = inProgressDownloadCondition();
    } else if (section === 'history') {
      where = terminalDownloadCondition();
    } else if (status) {
      // Translate display status into its two-axis predicate.
      where = displayStatusCondition(status as DownloadStatus);
    }

    const [{ value: total } = { value: 0 }] = await this.db
      .select({ value: count() })
      .from(downloads)
      .where(where);

    const query = this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(where)
      .orderBy(desc(downloads.addedAt), desc(downloads.id))
      .$dynamic();

    const results = await applyPagination(query, pagination);

    const data = results.map((r) => ({
      ...r.download,
      status: deriveDisplayStatus(r.download.clientStatus, r.download.pipelineStage),
      ...(r.book && { book: stripClearedFields(r.book) }),
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
      ...results[0]!.download,
      status: deriveDisplayStatus(results[0]!.download.clientStatus, results[0]!.download.pipelineStage),
      ...(results[0]!.book && { book: stripClearedFields(results[0]!.book) }),
      indexerName: results[0]!.indexer?.name ?? null,
    };
  }

  async getActive(): Promise<DownloadWithBook[]> {
    const results = await this.db
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(inProgressDownloadCondition())
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      status: deriveDisplayStatus(r.download.clientStatus, r.download.pipelineStage),
      ...(r.book && { book: stripClearedFields(r.book) }),
      indexerName: r.indexer?.name ?? null,
    }));
  }

  async getCounts(): Promise<{ active: number; completed: number }> {
    const activeCond = inProgressDownloadCondition();
    const completedCond = completedCountDownloadCondition();

    const rows = await this.db
      .select({
        isActive: sql<number>`CASE WHEN ${activeCond} THEN 1 ELSE 0 END`,
        cnt: count(),
      })
      .from(downloads)
      .where(or(activeCond, completedCond))
      .groupBy(sql`1`);

    let active = 0;
    let completed = 0;
    for (const row of rows) {
      if (Number(row.isActive) === 1) active = Number(row.cnt);
      else completed = Number(row.cnt);
    }

    return { active, completed };
  }

  /** `executor` lets a caller read the rows inside its own transaction — `downloads.book_id` is
   * ON DELETE SET NULL, so once the book row is gone this lookup can no longer find them. */
  async getActiveByBookId(bookId: number, executor: DbOrTx = this.db): Promise<DownloadWithBook[]> {
    const results = await executor
      .select({
        download: downloads,
        book: books,
        indexer: indexers,
      })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .leftJoin(indexers, eq(downloads.indexerId, indexers.id))
      .where(and(
        inProgressDownloadCondition(),
        eq(downloads.bookId, bookId),
      ))
      .orderBy(desc(downloads.addedAt));

    return results.map((r) => ({
      ...r.download,
      status: deriveDisplayStatus(r.download.clientStatus, r.download.pipelineStage),
      ...(r.book && { book: stripClearedFields(r.book) }),
      indexerName: r.indexer?.name ?? null,
    }));
  }

  /** Share private-indexer URL parsing with Usenet enrichment. */
  private buildLanAllowlist() {
    return this.wired.require().indexerService.getLanAllowlist();
  }

  /** Staging and adding are mutually exclusive: a stageable adapter has no control channel, so its
   * artifact is published after the row lands rather than compensated once the row fails. */
  private async sendToClient(artifact: DownloadArtifact, protocol: DownloadProtocol): Promise<{ externalId: string | null; staged: StagedHandoff | null; clientId: number; clientType: string; clientName: string }> {
    const client = await this.downloadClientService.getFirstEnabledForProtocol(protocol);
    if (!client) throw new Error('No download client configured');
    const adapter = await this.downloadClientService.getAdapter(client.id);
    if (!adapter) throw new Error('Could not initialize download client');
    const settings = (client.settings ?? {}) as Record<string, unknown>;
    const category = clientCategory(settings);
    const addOptions = { ...(category ? { category } : {}) };
    const options = Object.keys(addOptions).length > 0 ? addOptions : undefined;
    const identity = { clientId: client.id, clientType: client.type, clientName: client.name };
    if (adapter.stageDownload) {
      return { externalId: null, staged: await adapter.stageDownload(artifact, options), ...identity };
    }
    return { externalId: await adapter.addDownload(artifact, options), staged: null, ...identity };
  }

  /**
   * Shared grab blocker guard. PIPELINE_ACTIVE outranks replaceable blockers; completed rows
   * eligible for quality-gate and pending auto-import jobs also count as pipeline blockers.
   */
  private async checkDuplicateDownloads(bookId: number): Promise<void> {
    const classification = classifyBlockers(await gatherBookBlockers(this.db, bookId));
    if (classification.kind === 'pipeline') {
      throw new DuplicateDownloadError(
        `Book ${bookId} has a download in the import pipeline`,
        'PIPELINE_ACTIVE',
        { reason: classification.reason },
      );
    }
    if (classification.kind === 'replaceable') {
      throw new DuplicateDownloadError(
        `Book ${bookId} already has an active download`,
        'ACTIVE_DOWNLOAD_EXISTS',
        { active: classification.active },
      );
    }
  }

  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol | undefined;
    bookId?: number | undefined;
    indexerId?: number | undefined;
    size?: number | undefined;
    seeders?: number | undefined;
    guid?: string | undefined;
    isFreeleech?: boolean | undefined;
    skipDuplicateCheck?: boolean | undefined;
    infoHash?: string | undefined;
    source?: CreateEventInput['source'] | undefined;
    bookStatusAtGrab?: BookStatus | null | undefined;
  }): Promise<DownloadWithBook> {
    if (params.bookId && !params.skipDuplicateCheck) {
      await this.checkDuplicateDownloads(params.bookId);
    }

    const protocol = params.protocol ?? 'torrent';
    this.log.debug({ title: params.title, indexerId: params.indexerId, guid: params.guid, isFreeleech: params.isFreeleech, isWired: this.wired.isWired(), hasIndexerService: !!this.wired.peek()?.indexerService }, 'grab: pre-resolveAdapterDownloadUrl');
    const effectiveDownloadUrl = await resolveAdapterDownloadUrl(
      {
        downloadUrl: params.downloadUrl,
        protocol,
        ...(params.guid !== undefined && { guid: params.guid }),
        ...(params.indexerId !== undefined && { indexerId: params.indexerId }),
        ...(params.isFreeleech !== undefined && { isFreeleech: params.isFreeleech }),
        title: params.title,
      },
      this.log,
      this.wired.peek()?.indexerService,
    );
    this.log.debug({ title: params.title, urlChanged: effectiveDownloadUrl !== params.downloadUrl }, 'grab: post-resolveAdapterDownloadUrl');
    const { artifact, infoHash } = await resolveArtifact(effectiveDownloadUrl, protocol, () => this.buildLanAllowlist());

    this.log.debug({ protocol, downloadUrl: sanitizeLogUrl(effectiveDownloadUrl), infoHash }, 'Sending download to client');
    const { externalId, staged, clientId, clientType, clientName } = await this.sendToClient(artifact, protocol);
    // A staged artifact has not reached the client yet, and may never; say so rather than claim delivery.
    if (staged) this.log.debug({ clientName, bookId: params.bookId }, 'Download staged for client — published once the record lands');
    else this.log.debug({ externalId, clientName, bookId: params.bookId }, 'Download sent to client');

    // A failed insert publishes nothing and discards the staged artifact; with an external id
    // instead it removes the orphan best-effort, or logs it for recovery.
    const result = await insertDownloadRecordOrCompensate(
      this.db, this.log, params,
      { effectiveDownloadUrl, protocol, infoHash, clientId, clientType, externalId, staged },
      (id) => this.downloadClientService.getAdapter(id),
    );
    this.log.info({ title: params.title, indexerId: params.indexerId }, 'Download initiated');
    return this.getById(result[0]!.id) as Promise<DownloadWithBook>;
  }

  async updateProgress(id: number, progress: number, _bookId?: number): Promise<void> {
    // Progress is client truth; never infer or overwrite pipelineStage here.
    const clientStatus: ClientStatus = progress >= 1 ? 'completed' : 'downloading';
    const completedAt = progress >= 1 ? new Date() : null;

    // Preserve progressUpdatedAt unless progress changes; stuck detection depends on it.
    const existing = await this.db.select({ progress: downloads.progress }).from(downloads).where(eq(downloads.id, id));
    const progressChanged = !existing[0] || existing[0].progress !== progress;

    await transitionDownloadState(this.db, id, {
      clientStatus,
      progress,
      completedAt,
      ...(progressChanged ? { progressUpdatedAt: new Date() } : {}),
    });

    if (progress >= 1) {
      this.log.info({ id }, 'Download completed');
    }
  }

  async setError(id: number, errorMessage: string, _meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    // Reset both state axes atomically so a non-idle pipeline row derives as failed.
    await transitionDownloadState(this.db, id, { clientStatus: 'failed', pipelineStage: 'idle', errorMessage });
    // Named for what it is: `errorMessage` is an already-rendered string, and under the `error`
    // key a syntactic rule cannot tell it from a raw error object (#2604 AC7 R7).
    this.log.warn({ id, errorMessage }, 'Download error recorded');
  }

  /** Best-effort delete-files cleanup; replace calls this only after its DB claim commits. */
  async removeExternalItem(download: Pick<DownloadRow, 'id' | 'downloadClientId' | 'externalId'>): Promise<void> {
    if (!download.downloadClientId || !download.externalId) return;
    try {
      const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
      if (adapter) await adapter.removeDownload(download.externalId, true);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), id: download.id }, 'Failed to remove download from client');
    }
  }

  async cancel(id: number, reason = 'Cancelled by user'): Promise<boolean> {
    const download = await this.getById(id);
    if (!download) return false;

    // Plain cancel is destructive-first; guarded replacement commits its claim first.
    await this.removeExternalItem(download);

    // Reset pipelineStage with clientStatus so mid-pipeline cancellation derives as failed.
    await transitionDownloadState(this.db, id, { clientStatus: 'failed', pipelineStage: 'idle', errorMessage: reason });

    this.log.info({ id }, 'Download cancelled');
    return true;
  }

  async retry(id: number): Promise<RetryResult> {
    const download = await this.getById(id);
    if (!download) throw new DownloadError(`Download ${id} not found`, 'NOT_FOUND');
    if (download.status !== 'failed') throw new DownloadError(`Download ${id} is not in failed state`, 'INVALID_STATUS');
    if (!download.bookId) throw new DownloadError(`Download ${id} has no book linked`, 'NO_BOOK_LINKED');

    // Imported books require manual Search Releases; do not search or reset retry budget here.
    const bookRow = await this.db
      .select({ path: books.path })
      .from(books)
      .where(eq(books.id, download.bookId))
      .limit(1);
    if (bookRow[0]?.path != null) {
      throw new DownloadError(
        'Cannot auto-retry: book has been imported. Use Search Releases to manually pick a different release.',
        'IMPORTED_BOOK_NO_RETRY',
      );
    }

    const { retrySearchDeps } = this.wired.require();

    // A manual retry starts a new budget cycle.
    retrySearchDeps.retryBudget.reset(download.bookId);

    const result = await retrySearch(download.bookId, retrySearchDeps);

    switch (result.outcome) {
      case 'retried': {
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
      case 'already_active': {
        // A blocker serves the book; preserve the old failed row and its errorMessage.
        this.log.info({ id }, 'Manual retry: book already has a blocking download or import — not retrying');
        return { status: 'already_active' };
      }
      case 'retry_error': {
        await this.db.update(downloads).set({ errorMessage: RETRY_ERROR_MESSAGE }).where(eq(downloads.id, id));
        this.log.warn({ id, error: result.error }, 'Manual retry search failed');
        return { status: 'retry_error', error: result.error };
      }
    }
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    if (!isTerminalState(existing.clientStatus, existing.pipelineStage)) {
      throw new DownloadError(`Cannot delete download with status '${existing.status}' — use cancel instead`, 'INVALID_STATUS');
    }

    await this.db.delete(downloads).where(eq(downloads.id, id));
    this.log.info({ id }, 'Download history item deleted');
    return true;
  }

  async deleteHistory(): Promise<{ deleted: number }> {
    const rows = await this.db
      .delete(downloads)
      .where(terminalDownloadCondition())
      .returning({ id: downloads.id });
    const deleted = rows.length;
    this.log.info({ deleted }, 'Download history bulk deleted');
    return { deleted };
  }
}
