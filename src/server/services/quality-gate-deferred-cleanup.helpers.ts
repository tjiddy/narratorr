import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { QualityGateService } from './quality-gate.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { DownloadRow } from './types.js';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';
import { rm, stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';

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
    log.warn({ error }, 'Quality gate: failed to read import settings for deferred cleanup — skipping cycle');
    return;
  }

  const candidates = await qualityGateService.getDeferredCleanupCandidates();
  if (candidates.length === 0) return;

  for (const download of candidates) {
    try {
      await processDeferredCandidate(download, importSettings, deps);
    } catch (error: unknown) {
      log.warn({ downloadId: download.id, error }, 'Quality gate: deferred cleanup error — will retry next cycle');
    }
  }
}

async function processDeferredCandidate(
  download: DownloadRow,
  importSettings: { minSeedTime: number; minSeedRatio: number },
  deps: DeferredCleanupDeps,
): Promise<void> {
  const { downloadClientService, db, log } = deps;

  let currentRatio = 0;
  if (importSettings.minSeedRatio > 0 && download.downloadClientId && download.externalId) {
    const adapter = await downloadClientService.getAdapter(download.downloadClientId);
    const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
    currentRatio = liveState?.ratio ?? 0;
  }

  if (isTorrentRemovalDeferred(download, importSettings, currentRatio)) {
    log.debug({ downloadId: download.id }, 'Quality gate: deferred cleanup skipped — seed conditions not met');
    return;
  }

  const adapterSuccess = await deferredRemoveFromClient(download, deps);
  const filesDeleted = await deferredDeleteFiles(download, deps);

  if (adapterSuccess && filesDeleted) {
    await db.update(downloads).set({ pendingCleanup: null, outputPath: null }).where(eq(downloads.id, download.id));
  } else if (filesDeleted && !adapterSuccess) {
    await db.update(downloads).set({ outputPath: null }).where(eq(downloads.id, download.id));
  }
}

async function deferredRemoveFromClient(download: DownloadRow, deps: DeferredCleanupDeps): Promise<boolean> {
  const { downloadClientService, log } = deps;
  try {
    if (download.downloadClientId && download.externalId) {
      const adapter = await downloadClientService.getAdapter(download.downloadClientId);
      if (adapter) {
        await adapter.removeDownload(download.externalId, true);
        log.info({ downloadId: download.id }, 'Quality gate: deferred cleanup — removed download from client');
      }
    }
    return true;
  } catch (error: unknown) {
    log.warn({ downloadId: download.id, error }, 'Quality gate: deferred cleanup — failed to remove from client');
    return false;
  }
}

async function deferredDeleteFiles(download: DownloadRow, deps: DeferredCleanupDeps): Promise<boolean> {
  const { log } = deps;
  if (!download.outputPath) return true;

  try {
    await stat(download.outputPath);
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      log.debug({ downloadId: download.id }, 'Quality gate: deferred cleanup — outputPath does not exist or already removed');
      return true;
    }
    log.warn({ downloadId: download.id, outputPath: download.outputPath, error }, 'Quality gate: deferred cleanup — stat failed (non-ENOENT)');
    return false;
  }

  try {
    await rm(download.outputPath, { recursive: true, force: true });
    log.info({ downloadId: download.id, outputPath: download.outputPath }, 'Quality gate: deferred cleanup — deleted files');
    return true;
  } catch (error: unknown) {
    log.warn({ downloadId: download.id, outputPath: download.outputPath, error }, 'Quality gate: deferred cleanup — file deletion failed');
    return false;
  }
}
