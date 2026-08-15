import type { FastifyBaseLogger } from 'fastify';
import { stat } from 'node:fs/promises';
import { removeTree } from '@core/utils/remove-tree.js';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import type { DownloadClientService } from './download-client.service.js';
import type { DownloadRow } from './types.js';

/**
 * Own seed decisions and client/file actions. Callers retain DB markers, logging, and
 * missing-adapter policy.
 */

export interface TorrentSeedSettings {
  minSeedTime: number;
  minSeedRatio: number;
}

export interface TorrentRemovalDeps {
  downloadClientService: DownloadClientService;
  log: FastifyBaseLogger;
}

export interface RemoveOrDeferOptions {
  /**
   * When ratio is unavailable, true returns `live-state-unavailable`; false evaluates the normal
   * defer rule with ratio zero.
   */
  deferOnUnavailableRatio: boolean;
}

export type TorrentRemovalResult =
  | { outcome: 'removed' }
  | { outcome: 'no-adapter' }
  | { outcome: 'deferred'; currentRatio: number }
  | { outcome: 'live-state-unavailable' }
  | { outcome: 'remove-failed'; error: unknown };

async function fetchLiveRatio(download: DownloadRow, deps: TorrentRemovalDeps): Promise<number | null> {
  if (!download.downloadClientId || !download.externalId) return null;
  const adapter = await deps.downloadClientService.getAdapter(download.downloadClientId);
  const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
  return liveState ? liveState.ratio : null;
}

async function removeTorrent(download: DownloadRow, deps: TorrentRemovalDeps): Promise<TorrentRemovalResult> {
  if (!download.downloadClientId || !download.externalId) return { outcome: 'no-adapter' };
  const adapter = await deps.downloadClientService.getAdapter(download.downloadClientId);
  if (!adapter) return { outcome: 'no-adapter' };
  try {
    await adapter.removeDownload(download.externalId, true);
    return { outcome: 'removed' };
  } catch (error: unknown) {
    return { outcome: 'remove-failed', error };
  }
}

/**
 * Ratio-fetch errors propagate to the caller; only `removeDownload` failures become a result
 * variant.
 */
export async function removeOrDeferTorrent(
  download: DownloadRow,
  settings: TorrentSeedSettings,
  deps: TorrentRemovalDeps,
  options: RemoveOrDeferOptions,
): Promise<TorrentRemovalResult> {
  let currentRatio = 0;
  if (settings.minSeedRatio > 0) {
    const liveRatio = await fetchLiveRatio(download, deps);
    if (liveRatio === null) {
      if (options.deferOnUnavailableRatio) return { outcome: 'live-state-unavailable' };
      // Otherwise evaluate the normal defer rule with ratio zero.
    } else {
      currentRatio = liveRatio;
    }
  }

  if (isTorrentRemovalDeferred(download, settings, currentRatio)) {
    return { outcome: 'deferred', currentRatio };
  }

  return removeTorrent(download, deps);
}

/**
 * True means nothing remains to delete; false means deletion is uncertain or failed. Deferred
 * cleanup checks this before clearing DB markers, while immediate rejection is best effort.
 */
export async function deleteDownloadOutputPath(download: DownloadRow, log: FastifyBaseLogger): Promise<boolean> {
  const outputPath = download.outputPath;
  if (!outputPath) return true;

  try {
    await stat(outputPath);
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      log.debug({ downloadId: download.id, outputPath }, 'Torrent removal: outputPath already gone — skipping delete');
      return true;
    }
    log.warn({ downloadId: download.id, outputPath, error: serializeError(error) }, 'Torrent removal: stat failed (non-ENOENT) — skipping delete');
    return false;
  }

  try {
    await removeTree(outputPath);
    log.info({ downloadId: download.id, outputPath }, 'Torrent removal: deleted output path');
    return true;
  } catch (error: unknown) {
    log.warn({ downloadId: download.id, outputPath, error: serializeError(error) }, 'Torrent removal: output path file deletion failed');
    return false;
  }
}
