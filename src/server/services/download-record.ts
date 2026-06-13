import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { DownloadProtocol } from '../../core/index.js';
import { DownloadUrl, type LanAllowlist } from '../../core/utils/download-url.js';
import type { DownloadArtifact } from '../../core/download-clients/types.js';
import type { BookStatus } from '../../shared/schemas/book.js';

/** Resolve a downloadUrl into a typed artifact. HTTP grabs (torrent *and*
 *  usenet) need the LAN allowlist: torrent fetches the bytes here, while the
 *  usenet NZB-URL passthrough threads the allowlist into the Blackhole adapter's
 *  own redirect-following self-download (#966, #1243). magnet and data: grabs
 *  return artifacts without an outbound HTTP fetch. */
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

export async function insertDownloadRecord(
  db: Db,
  log: FastifyBaseLogger,
  params: InsertDownloadRecordParams,
  ctx: InsertDownloadRecordCtx,
): Promise<{ id: number }[]> {
  const isHandoff = !ctx.externalId;
  // A fresh grab is pure client truth — `pipelineStage` defaults to 'idle'.
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
      externalId: ctx.externalId ?? undefined,
      bookStatusAtGrab: params.bookStatusAtGrab ?? null,
    })
    .returning();
}
