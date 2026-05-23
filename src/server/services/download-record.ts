import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '../../db/schema.js';
import type { DownloadProtocol } from '../../core/index.js';
import { DownloadUrl, type LanAllowlist } from '../../core/utils/download-url.js';
import type { DownloadArtifact } from '../../core/download-clients/types.js';
import type { BookStatus } from '../../shared/schemas/book.js';

/** Resolve a downloadUrl into a typed artifact. Only the torrent HTTP path
 *  needs the LAN allowlist; magnet, data:, and usenet-passthrough grabs return
 *  artifacts without an outbound HTTP fetch (#966). */
export async function resolveArtifact(
  effectiveDownloadUrl: string,
  protocol: DownloadProtocol,
  buildLanAllowlist: () => Promise<LanAllowlist>,
): Promise<{ artifact: DownloadArtifact; infoHash: string | null }> {
  const downloadUrlObj = new DownloadUrl(effectiveDownloadUrl, protocol);
  const isTorrentHttp = protocol === 'torrent' && downloadUrlObj.isHttp;
  const lanAllowlist = isTorrentHttp ? await buildLanAllowlist() : undefined;
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

export async function insertDownloadRecord(
  db: Db,
  log: FastifyBaseLogger,
  params: InsertDownloadRecordParams,
  ctx: InsertDownloadRecordCtx,
): Promise<{ id: number }[]> {
  const isHandoff = !ctx.externalId;
  const downloadStatus: 'completed' | 'downloading' = isHandoff ? 'completed' : 'downloading';
  const downloadProgress = isHandoff ? 1 : 0;
  const downloadCompletedAt = isHandoff ? new Date() : undefined;
  if (isHandoff) {
    log.info({ title: params.title, clientType: ctx.clientType }, 'Handoff client — download completed immediately (no progress tracking)');
  }
  return db
    .insert(downloads)
    .values({
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
      status: downloadStatus,
      progress: downloadProgress,
      completedAt: downloadCompletedAt,
      externalId: ctx.externalId ?? undefined,
      bookStatusAtGrab: params.bookStatusAtGrab ?? null,
    })
    .returning();
}
