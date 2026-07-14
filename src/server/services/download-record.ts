import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { DownloadProtocol } from '../../core/index.js';
import { DownloadUrl, type LanAllowlist } from '../../core/utils/download-url.js';
import type { DownloadArtifact } from '../../core/download-clients/types.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import { serializeError } from '../utils/serialize-error.js';

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

/** Minimal adapter shape the insert-failure compensation needs. */
interface CompensationAdapter {
  removeDownload(externalId: string, deleteFiles: boolean): Promise<unknown>;
}

/**
 * Insert the download row; on insert failure AFTER a successful client-add,
 * best-effort compensate a tracked download via `removeDownload(externalId, true)`
 * (delete-files, matching the cancel path — NOT the adapter default `false`, F30)
 * before rethrowing, so the just-admitted payload is not left orphaned (F5). The
 * no-orphan guarantee is best-effort, not absolute (#1857 F1/F18): BOTH a null
 * adapter (compensation cannot run) AND a throwing `removeDownload` leave a live
 * untracked external download — either way the orphaned `externalId` is logged for
 * operator recovery. Blackhole (null externalId) has no id to compensate.
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
  // Adapter was null — compensation could not run; the orphan still needs logging.
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
      // Normalize '' → null at the insert seam so an adapter returning an empty
      // external id can never persist a `''` that would strand as a permanent
      // QG/import blocker no consumer drains (#1861). Matches `isHandoff` above.
      externalId: ctx.externalId || null,
      bookStatusAtGrab: params.bookStatusAtGrab ?? null,
    })
    .returning();
}
