import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { QualityGateService } from './quality-gate.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { DownloadRow } from './types.js';
import { removeOrDeferTorrent, deleteDownloadOutputPath } from './torrent-removal.helpers.js';
import { eq } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';
import { serializeError } from '../utils/serialize-error.js';


export interface DeferredCleanupDeps {
  qualityGateService: QualityGateService;
  downloadClientService: DownloadClientService;
  settingsService: SettingsService | undefined;
  db: Db;
  log: FastifyBaseLogger;
}

/**
 * Process deferred rejection cleanups — downloads where seed time was not yet elapsed
 * at rejection time. Re-checks seed time and performs file deletion + client deregistration
 * for candidates where the threshold has now passed.
 */
export async function cleanupDeferredRejections(deps: DeferredCleanupDeps): Promise<void> {
  const { qualityGateService, settingsService, log } = deps;

  let importSettings = { minSeedTime: 0, minSeedRatio: 0 };
  try {
    if (settingsService) {
      const settings = await settingsService.get('import');
      importSettings = { minSeedTime: settings.minSeedTime, minSeedRatio: settings.minSeedRatio };
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Quality gate: failed to read import settings for deferred cleanup — skipping cycle');
    return;
  }

  const candidates = await qualityGateService.getDeferredCleanupCandidates();
  if (candidates.length === 0) return;

  for (const download of candidates) {
    try {
      await processDeferredCandidate(download, importSettings, deps);
    } catch (error: unknown) {
      log.warn({ downloadId: download.id, error: serializeError(error) }, 'Quality gate: deferred cleanup error — will retry next cycle');
    }
  }
}

async function processDeferredCandidate(
  download: DownloadRow,
  importSettings: { minSeedTime: number; minSeedRatio: number },
  deps: DeferredCleanupDeps,
): Promise<void> {
  const { downloadClientService, db, log } = deps;

  // Deferred cleanup folds a missing adapter / live state into ratio 0 (deferOnUnavailableRatio:
  // false) and treats a null adapter on the proceed path as adapter-success (so file deletion
  // may still clear markers per `filesDeleted`).
  const result = await removeOrDeferTorrent(download, importSettings,
    { downloadClientService, log },
    { deferOnUnavailableRatio: false });

  if (result.outcome === 'deferred' || result.outcome === 'live-state-unavailable') {
    log.debug({ downloadId: download.id }, 'Quality gate: deferred cleanup skipped — seed conditions not met');
    return; // Leave the existing pendingCleanup marker untouched for next cycle.
  }

  if (result.outcome === 'removed') {
    log.info({ downloadId: download.id }, 'Quality gate: deferred cleanup — removed download from client');
  } else if (result.outcome === 'remove-failed') {
    log.warn({ downloadId: download.id, error: serializeError(result.error) }, 'Quality gate: deferred cleanup — failed to remove from client');
  }
  // A null adapter ('no-adapter') counts as adapter-success — no removeDownload call was needed.
  const adapterSuccess = result.outcome !== 'remove-failed';
  const filesDeleted = await deleteDownloadOutputPath(download, log);

  if (adapterSuccess && filesDeleted) {
    await db.update(downloads).set({ pendingCleanup: null, outputPath: null }).where(eq(downloads.id, download.id));
  } else if (filesDeleted && !adapterSuccess) {
    await db.update(downloads).set({ outputPath: null }).where(eq(downloads.id, download.id));
  }
}
