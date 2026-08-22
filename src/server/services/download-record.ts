import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { DownloadProtocol } from '@core/index.js';
import { DownloadUrl, type LanAllowlist } from '@core/utils/download-url.js';
import type { DownloadArtifact, StagedHandoff } from '@core/download-clients/types.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { serializeError } from '../utils/serialize-error.js';
import { transitionDownloadState } from '../utils/download-state.js';

/**
 * HTTP torrent and NZB grabs require the LAN allowlist, including Blackhole's later redirecting
 * fetch. Magnet and data URLs require no outbound request.
 */
export async function resolveArtifact(
  effectiveDownloadUrl: string,
  protocol: DownloadProtocol,
  buildLanAllowlist: () => Promise<LanAllowlist>,
): Promise<{ artifact: DownloadArtifact; infoHash: string | null }> {
  const downloadUrlObj = new DownloadUrl(effectiveDownloadUrl, protocol);
  const isHttpGrab = downloadUrlObj.isHttp && (protocol === 'torrent' || protocol === 'usenet');
  const lanAllowlist = isHttpGrab ? await buildLanAllowlist() : undefined;
  const artifact = await downloadUrlObj.resolve(lanAllowlist);
  const infoHash = 'infoHash' in artifact ? artifact.infoHash : null;
  return { artifact, infoHash };
}

export interface InsertDownloadRecordParams {
  title: string;
  bookId?: number | undefined;
  indexerId?: number | undefined;
  size?: number | undefined;
  seeders?: number | undefined;
  guid?: string | undefined;
  bookStatusAtGrab?: BookStatus | null | undefined;
}

export interface InsertDownloadRecordCtx {
  effectiveDownloadUrl: string;
  protocol: DownloadProtocol;
  infoHash: string | null;
  clientId: number;
  clientType: string;
  externalId: string | null;
  /** A handoff artifact written but not yet consumable; mutually exclusive with an external id. */
  staged: StagedHandoff | null;
}

interface CompensationAdapter {
  removeDownload(externalId: string, deleteFiles: boolean): Promise<unknown>;
}

const PUBLISH_FAILED_MESSAGE = 'Handoff artifact could not be published to the download client watch directory';

/**
 * A staged handoff publishes only once its row is durable, so a failed insert can discard the
 * artifact and nothing consumable is ever left unrecorded. With an external id instead, DB
 * failure best-effort removes the external download with files before rethrowing; missing or
 * failing adapters leave an orphan whose id is logged.
 */
export async function insertDownloadRecordOrCompensate(
  db: Db,
  log: FastifyBaseLogger,
  params: InsertDownloadRecordParams,
  ctx: InsertDownloadRecordCtx,
  getAdapter: (clientId: number) => Promise<CompensationAdapter | null>,
): Promise<{ id: number }[]> {
  let rows: { id: number }[];
  try {
    rows = await insertDownloadRecord(db, log, params, ctx);
  } catch (insertError: unknown) {
    // Deliberately untrimmed, unlike insertDownloadRecord's #2489 guard: a blank id here takes the
    // compensation arm whose blank-input refusal is pinned by blank-external-id.integration.test.ts
    // (#2485), and the adapter is the right place to refuse an id it never issued.
    if (ctx.externalId) await compensateOrphanedDownload(log, getAdapter, ctx.clientId, ctx.externalId);
    if (ctx.staged) await discardStagedHandoff(log, ctx.staged);
    throw insertError;
  }
  if (ctx.staged) await publishStagedHandoff(db, log, ctx.staged, rows[0]!.id);
  return rows;
}

/**
 * The row is already durable, so a rejected publish leaves a completed record describing an
 * artifact nobody can consume. Repair it, discard the artifact, and surface the publish failure
 * itself — both follow-ups are best-effort and neither may mask the error being unwound.
 */
async function publishStagedHandoff(db: Db, log: FastifyBaseLogger, staged: StagedHandoff, id: number): Promise<void> {
  try {
    await staged.commit();
  } catch (commitError: unknown) {
    log.warn({ error: serializeError(commitError), id }, 'Download record inserted but the handoff artifact could not be published — marking the row failed');
    await repairUnpublishedRow(db, log, id);
    await discardStagedHandoff(log, staged);
    throw commitError;
  }
}

async function repairUnpublishedRow(db: Db, log: FastifyBaseLogger, id: number): Promise<void> {
  try {
    const landed = await transitionDownloadState(db, id, {
      clientStatus: 'failed',
      pipelineStage: 'idle',
      errorMessage: PUBLISH_FAILED_MESSAGE,
    });
    if (!landed) {
      log.warn({ id }, 'Handoff publish failed and no row matched the repair — the record is already gone');
    }
  } catch (repairError: unknown) {
    // Deliberately not retried: the row remains completed with no artifact, the same residue a
    // crash in this window leaves, and the Activity entry is what makes it operator-visible.
    log.warn({ error: serializeError(repairError), id }, 'Handoff publish failed and the repair could not be recorded — the row remains completed with no artifact');
  }
}

async function discardStagedHandoff(log: FastifyBaseLogger, staged: StagedHandoff): Promise<void> {
  try {
    await staged.abort();
  } catch (abortError: unknown) {
    log.warn({ error: serializeError(abortError) }, 'Staged handoff could not be discarded — a stale temp file may remain in the watch directory');
  }
}

async function compensateOrphanedDownload(
  log: FastifyBaseLogger,
  getAdapter: (clientId: number) => Promise<CompensationAdapter | null>,
  clientId: number,
  externalId: string,
): Promise<void> {
  try {
    const adapter = await getAdapter(clientId);
    if (adapter) {
      await adapter.removeDownload(externalId, true);
      return;
    }
  } catch (compError: unknown) {
    log.warn(
      { error: serializeError(compError), externalId, clientId },
      'Download insert failed AND compensation removeDownload failed — orphaned external download (operator recovery needed)',
    );
    return;
  }
  log.warn(
    { externalId, clientId },
    'Download insert failed AND compensation adapter unavailable — orphaned external download (operator recovery needed)',
  );
}

export async function insertDownloadRecord(
  db: Db,
  log: FastifyBaseLogger,
  params: InsertDownloadRecordParams,
  ctx: InsertDownloadRecordCtx,
): Promise<{ id: number }[]> {
  // Trim before every decision below: a whitespace-only id from a client API would otherwise pass
  // each reader's falsy guard while matching nothing in the client — the un-cancellable ghost
  // download #2485 hardened qBittorrent against, blocked here at the only write site (#2489).
  const externalId = ctx.externalId?.trim() || null;
  const isHandoff = !externalId;
  const clientStatus: 'completed' | 'downloading' = isHandoff ? 'completed' : 'downloading';
  const downloadProgress = isHandoff ? 1 : 0;
  const downloadCompletedAt = isHandoff ? new Date() : undefined;
  if (isHandoff) {
    log.info({ title: params.title, clientType: ctx.clientType }, 'Handoff client — download completed immediately (no progress tracking)');
  }
  return db
    .insert(downloads)
    .values({
      publicId: generatePublicId('dl'),
      bookId: params.bookId,
      indexerId: params.indexerId,
      downloadClientId: ctx.clientId,
      title: params.title,
      protocol: ctx.protocol,
      infoHash: ctx.infoHash,
      guid: params.guid,
      downloadUrl: ctx.effectiveDownloadUrl,
      size: params.size,
      seeders: params.seeders,
      clientStatus,
      progress: downloadProgress,
      completedAt: downloadCompletedAt,
      // Empty external ids must become handoffs, never permanent pipeline blockers.
      externalId,
      bookStatusAtGrab: params.bookStatusAtGrab ?? null,
    })
    .returning();
}
