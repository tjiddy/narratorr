import type { FastifyBaseLogger } from 'fastify';
import { rm, stat } from 'node:fs/promises';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import type { DownloadClientService } from './download-client.service.js';
import type { DownloadRow } from './types.js';

/**
 * Shared torrent seed-gating + removal helpers.
 *
 * Consolidates the adapter-resolve → fetch-live-ratio → defer-decision → removeDownload
 * ring that was copy-pasted across the import path, the quality-gate rejection path, and
 * the quality-gate deferred-cleanup path. The helpers stay deliberately policy-free: they
 * make the seed/ratio decision and perform the client-side removal / file deletion, but the
 * caller decides `outputPath`-nulling, `pendingCleanup` writes, warning emission, and how to
 * treat a missing adapter. That is what lets the four sites share code while preserving each
 * one's divergent bookkeeping (see #1293).
 */

/** Minimal seed-gating settings shape — a named slice of the import settings the callers thread inline. */
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
   * When the live ratio cannot be fetched (adapter or live state unavailable) while ratio
   * gating is on, `true` short-circuits to a `live-state-unavailable` result so the caller can
   * defer; `false` folds the missing ratio to `0` and runs the normal defer decision (which,
   * for torrents with `minSeedRatio > 0`, still defers since `0 < minSeedRatio`, but lets
   * non-torrent / seed-time-only cases proceed). The initial import path passes `true`; the
   * quality-gate rejection and deferred-cleanup paths pass `false`.
   */
  deferOnUnavailableRatio: boolean;
}

/**
 * Result of {@link removeOrDeferTorrent}. The variants are deliberately distinct so each caller
 * can apply its own DB-write / logging policy:
 * - `removed` — seed conditions met, adapter resolved, `removeDownload` succeeded.
 * - `no-adapter` — seed conditions met, but no adapter / client id to remove through. No call made.
 * - `deferred` — seed conditions not yet met (ratio known or folded to `0`). No removal attempted.
 * - `live-state-unavailable` — ratio gating on, live ratio unfetchable, and the caller opted to
 *   defer on it (`deferOnUnavailableRatio: true`). No removal attempted.
 * - `remove-failed` — `removeDownload` threw; carries the error for the caller to log.
 */
export type TorrentRemovalResult =
  | { outcome: 'removed' }
  | { outcome: 'no-adapter' }
  | { outcome: 'deferred'; currentRatio: number }
  | { outcome: 'live-state-unavailable' }
  | { outcome: 'remove-failed'; error: unknown };

/** Fetch the current seed ratio from the live download state, or `null` if it cannot be determined. */
async function fetchLiveRatio(download: DownloadRow, deps: TorrentRemovalDeps): Promise<number | null> {
  if (!download.downloadClientId || !download.externalId) return null;
  const adapter = await deps.downloadClientService.getAdapter(download.downloadClientId);
  const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
  return liveState ? liveState.ratio : null;
}

/** Resolve the adapter and remove the torrent. Catches `removeDownload` failures into the result. */
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
 * Fetch the live ratio (only when ratio gating is on), run the {@link isTorrentRemovalDeferred}
 * decision, and either signal a defer outcome or remove the torrent from the client.
 *
 * Adapter/`getDownload` errors raised while fetching the ratio are NOT caught here — they
 * propagate so the caller's surrounding try/catch handles them exactly as before. Only the
 * `removeDownload` call is caught (into `remove-failed`).
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
      // else: fold the missing ratio to 0 and let the defer decision run (non-torrent escapes).
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
 * Best-effort deletion of the persisted download `outputPath`, with an ENOENT-tolerant guard.
 *
 * Return contract (callers depend on this exact mapping):
 * - `true`  — `outputPath` is null (nothing to delete), the path is already gone (`ENOENT`), or `rm` succeeded.
 * - `false` — a non-ENOENT `stat` failure, or an `rm` failure (the files may still exist).
 *
 * The quality-gate rejection path intentionally ignores the boolean (best-effort); the deferred
 * cleanup path branches on it before clearing `outputPath`/`pendingCleanup` DB markers.
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
    await rm(outputPath, { recursive: true, force: true });
    log.info({ downloadId: download.id, outputPath }, 'Torrent removal: deleted output path');
    return true;
  } catch (error: unknown) {
    log.warn({ downloadId: download.id, outputPath, error: serializeError(error) }, 'Torrent removal: output path file deletion failed');
    return false;
  }
}
