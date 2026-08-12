import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { DownloadProtocol } from '@core/index.js';
import { DownloadUrl, type LanAllowlist } from '@core/utils/download-url.js';
import type { DownloadArtifact } from '@core/download-clients/types.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { serializeError } from '../utils/serialize-error.js';

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
}

interface CompensationAdapter {
  removeDownload(externalId: string, deleteFiles: boolean): Promise<unknown>;
}

/**
 * If DB insertion fails after client admission, best-effort remove the external download with
 * files before rethrowing. Missing or failing adapters leave an orphan whose id is logged.
 */
export async function insertDownloadRecordOrCompensate(
  db: Db,
  log: FastifyBaseLogger,
  params: InsertDownloadRecordParams,
  ctx: InsertDownloadRecordCtx,
  getAdapter: (clientId: number) => Promise<CompensationAdapter | null>,
): Promise<{ id: number }[]> {
  try {
    return await insertDownloadRecord(db, log, params, ctx);
  } catch (insertError: unknown) {
    if (ctx.externalId) await compensateOrphanedDownload(log, getAdapter, ctx.clientId, ctx.externalId);
    throw insertError;
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
  const isHandoff = !ctx.externalId;
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
      externalId: ctx.externalId || null,
      bookStatusAtGrab: params.bookStatusAtGrab ?? null,
    })
    .returning();
}
