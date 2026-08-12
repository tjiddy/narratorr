import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { downloads } from '@db/schema.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import { inProgressDownloadCondition } from '../utils/download-state.js';
import { getErrorMessage } from '../utils/error-message.js';
import { mapHardcoverError } from '../utils/hardcover-error.js';
import { HardcoverClient } from '@core/metadata/hardcover.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';
import { getUpdateStatus, checkForUpdate } from '../jobs/version-check.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import { resolveMutagenDetection } from '@core/utils/mutagen-resolver.js';


export type HealthState = 'healthy' | 'warning' | 'error';

export type HealthCheckTarget =
  | { kind: 'indexer'; id: number }
  | { kind: 'download-client'; id: number }
  | { kind: 'settings'; path: string }
  | { kind: 'route'; path: string };

export interface HealthCheckResult {
  checkName: string;
  state: HealthState;
  message?: string | undefined;
  target?: HealthCheckTarget | undefined;
  link?: { url: string; label: string } | undefined;
}

export interface SystemDeps {
  fsAccess: (path: string, mode?: number) => Promise<void>;
  fsStatfs: (path: string) => Promise<{ bavail: number; bsize: number }>;
  probeFfmpeg: (path: string) => Promise<string>;
  probeMutagen: (pythonPath: string) => Promise<string>;
  resolveProxyIp: (proxyUrl: string) => Promise<string>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

// Three identical network states suppress short blips (observed Hardcover ~7s); card and API detection stay immediate.
const NETWORK_CHECK_CONFIRMATION_PASSES = 3;

// Only live external checks use hysteresis; local failures notify on their first pass.
function isNetworkBackedCheck(checkName: string): boolean {
  return checkName === 'hardcover'
    || checkName.startsWith('indexer:')
    || checkName.startsWith('download-client:');
}

// Connector names are mutable and non-unique, so track them by kind plus never-reused database id.
// Other targets can collide, so singleton checkName is their identity; HealthDashboard.cardKey mirrors this rule.
function trackingKey(result: HealthCheckResult): string {
  const target = result.target;
  if (target?.kind === 'indexer' || target?.kind === 'download-client') {
    return `${target.kind}:${target.id}`;
  }
  return result.checkName;
}

export class HealthCheckService {
  // Consecutive exact-state observations, clamped at the confirmation threshold.
  private pendingStates: Map<string, { state: HealthState; passes: number }> = new Map();
  // Announced state stays separate so unconfirmed blips cannot emit orphaned “resolved” notifications.
  // Unseen keys default healthy, so persistent failures re-alert after restart and confirmation.
  private notifiedStates: Map<string, HealthState> = new Map();
  private cachedResults: HealthCheckResult[] = [];
  private running = false;
  private pendingRerun = false;
  private versionUpdateCallback?: () => void;
  // Overlapping callers wait for a full pass begun after registration, preserving manual version-fetch freshness.
  private trailingWaiters: Array<(results: HealthCheckResult[]) => void> = [];

  constructor(
    private indexerService: IndexerService,
    private downloadClientService: DownloadClientService,
    private settingsService: SettingsService,
    private notifierService: NotifierService,
    private db: Db,
    private log: FastifyBaseLogger,
    private deps: SystemDeps,
  ) {}

  // Coalesce overlap into trailing passes; each overlapping caller waits for a pass begun after it registered.
  // This prevents a manual version fetch from receiving cached results computed before that fetch.
  async runAllChecks(): Promise<HealthCheckResult[]> {
    if (this.running) {
      this.pendingRerun = true;
      return new Promise<HealthCheckResult[]>((resolve) => {
        this.trailingWaiters.push(resolve);
      });
    }
    this.running = true;

    try {
      let results: HealthCheckResult[];
      do {
        this.pendingRerun = false;
        // Snapshot waiters before the pass; arrivals during it wait for the next guaranteed iteration.
        const waiters = this.trailingWaiters;
        this.trailingWaiters = [];
        results = await this.runChecksOnce();
        this.cachedResults = results;
        for (const resolve of waiters) resolve(results);
      } while (this.pendingRerun);
      return results;
    } finally {
      this.running = false;
    }
  }

  // Reuse the scheduled version job's update-change callback for manual runs; non-job contexts may omit it.
  setVersionUpdateCallback(callback: () => void): void {
    this.versionUpdateCallback = callback;
  }

  // Refresh the daily version cache before a manual report so its row cannot be up to 24 hours stale.
  // Awaited fetch plus trailing-pass coalescing guarantees post-fetch results even during a scheduled pass.
  // Fetch failure falls back to cached state; scheduled health runs call runAllChecks directly and pay no fetch cost.
  async runManualChecks(log: FastifyBaseLogger): Promise<HealthCheckResult[]> {
    await checkForUpdate(log, this.versionUpdateCallback).catch((error: unknown) => {
      log.error({ error: serializeError(error) }, 'Manual health run: live version check failed');
    });
    return this.runAllChecks();
  }

  private async runChecksOnce(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    // Isolate checks so one failure cannot suppress the rest.
    const checks = [
      () => this.checkIndexers(),
      () => this.checkDownloadClients(),
      () => this.checkLibraryRoot(),
      () => this.checkDiskSpace(),
      () => this.checkFfmpeg(),
      () => this.checkMutagen(),
      () => this.checkHardcover(),
      () => this.checkStuckDownloads(),
      () => this.checkVersionUpdate(),
    ];

    for (const check of checks) {
      try {
        const checkResults = await check();
        results.push(...checkResults);
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error) }, 'Health check failed');
      }
    }

    // Missing checks freeze rather than reset confirmation state; local checks require only one pass.
    for (const result of results) {
      const key = trackingKey(result);
      const required = isNetworkBackedCheck(result.checkName) ? NETWORK_CHECK_CONFIRMATION_PASSES : 1;
      const pending = this.pendingStates.get(key);
      // Confirm exact tri-state values so warning/error flapping restarts the run.
      const passes = Math.min(pending?.state === result.state ? pending.passes + 1 : 1, required);
      this.pendingStates.set(key, { state: result.state, passes });

      const notifiedState = this.notifiedStates.get(key) ?? 'healthy';
      if (passes < required || result.state === notifiedState) continue;

      // Use the confirming pass's current name and diagnostic, not the first observation's stale text.
      fireAndForget(
        this.notifierService.notify('on_health_issue', {
          event: 'on_health_issue',
          health: {
            checkName: result.checkName,
            previousState: notifiedState,
            currentState: result.state,
            message: result.message,
          },
        }),
        this.log,
        'Failed to send health issue notification',
      );
      this.notifiedStates.set(key, result.state);
    }

    return results;
  }

  getAggregateState(): HealthState {
    if (this.cachedResults.some((r) => r.state === 'error')) return 'error';
    if (this.cachedResults.some((r) => r.state === 'warning')) return 'warning';
    return 'healthy';
  }

  getCachedResults(): HealthCheckResult[] {
    return this.cachedResults;
  }

  async probeFfmpeg(path: string): Promise<string> {
    return this.deps.probeFfmpeg(path);
  }

  async probeProxy(proxyUrl: string): Promise<string> {
    return this.deps.resolveProxyIp(proxyUrl);
  }

  _reset(): void {
    this.pendingStates.clear();
    this.notifiedStates.clear();
    this.cachedResults = [];
    this.running = false;
    this.pendingRerun = false;
  }

  private async checkIndexers(): Promise<HealthCheckResult[]> {
    const indexers = await this.indexerService.getAll();
    const results: HealthCheckResult[] = [];

    for (const indexer of indexers) {
      if (!indexer.enabled) continue;
      const target: HealthCheckTarget = { kind: 'indexer', id: indexer.id };
      try {
        const result = await this.indexerService.test(indexer.id);
        const state = result.success
          ? (result.warning ? 'warning' : 'healthy')
          : 'error';
        results.push({
          checkName: `indexer:${indexer.name}`,
          state,
          message: result.success ? result.warning : result.message,
          target,
        });
      } catch (error: unknown) {
        results.push({
          checkName: `indexer:${indexer.name}`,
          state: 'error',
          message: getErrorMessage(error),
          target,
        });
      }
    }

    return results;
  }

  private async checkDownloadClients(): Promise<HealthCheckResult[]> {
    const clients = await this.downloadClientService.getAll();
    const results: HealthCheckResult[] = [];

    for (const client of clients) {
      if (!client.enabled) continue;
      const target: HealthCheckTarget = { kind: 'download-client', id: client.id };
      try {
        const result = await this.downloadClientService.test(client.id);
        results.push({
          checkName: `download-client:${client.name}`,
          state: result.success ? 'healthy' : 'error',
          message: result.success ? undefined : result.message,
          target,
        });
      } catch (error: unknown) {
        results.push({
          checkName: `download-client:${client.name}`,
          state: 'error',
          message: getErrorMessage(error),
          target,
        });
      }
    }

    return results;
  }

  private async checkLibraryRoot(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'route', path: '/settings' };
    const librarySettings = await this.settingsService.get('library');
    const libraryPath = librarySettings?.path;
    if (!libraryPath) {
      return [{ checkName: 'library-root', state: 'error', message: 'Library path not configured', target }];
    }

    try {
      // Require both read and write access (R_OK=4, W_OK=2).
      await this.deps.fsAccess(libraryPath, 4 | 2);
      return [{ checkName: 'library-root', state: 'healthy', target }];
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
      const message = code === 'ENOENT'
        ? `Library path does not exist: ${libraryPath}`
        : `Library path not writable: ${libraryPath}`;
      return [{ checkName: 'library-root', state: 'error', message, target }];
    }
  }

  private async checkDiskSpace(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'route', path: '/settings' };
    const librarySettings = await this.settingsService.get('library');
    const importSettings = await this.settingsService.get('import');
    const libraryPath = librarySettings?.path;
    const thresholdGB = importSettings?.minFreeSpaceGB ?? 5;

    if (!libraryPath) {
      return [{ checkName: 'disk-space', state: 'warning', message: 'Library path not configured', target }];
    }

    try {
      const stats = await this.deps.fsStatfs(libraryPath);
      const freeBytes = stats.bavail * stats.bsize;
      const freeGB = freeBytes / (1024 * 1024 * 1024);

      if (freeBytes === 0) {
        return [{ checkName: 'disk-space', state: 'error', message: 'No free disk space', target }];
      }
      if (freeGB < thresholdGB) {
        return [{
          checkName: 'disk-space',
          state: 'warning',
          message: `Low disk space: ${freeGB.toFixed(1)} GB free (threshold: ${thresholdGB} GB)`,
          target,
        }];
      }
      return [{ checkName: 'disk-space', state: 'healthy', target }];
    } catch (error: unknown) {
      return [{ checkName: 'disk-space', state: 'error', message: `Failed to check disk space: ${getErrorMessage(error)}`, target }];
    }
  }

  private async checkFfmpeg(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'settings', path: 'audio-tools' };
    const ffmpegPath = await resolveFfmpegPath();

    if (!ffmpegPath) {
      // Missing ffmpeg is silent unless unattended auto-merge needs it. Tag embedding moved to the
      // mutagen check; manual tools surface the absence inline and must not raise persistent alarms.
      const processing = await this.settingsService.get('processing');
      if (processing?.autoMergeDownloads !== true) {
        return [];
      }
      return [{
        checkName: 'ffmpeg',
        state: 'error',
        message: 'ffmpeg not found but auto-merge needs it — install it or set FFMPEG_PATH',
        target,
      }];
    }

    try {
      await this.deps.probeFfmpeg(ffmpegPath);
      return [{ checkName: 'ffmpeg', state: 'healthy', target }];
    } catch {
      return [{ checkName: 'ffmpeg', state: 'error', message: `ffmpeg not usable at: ${ffmpegPath}`, target }];
    }
  }

  private async checkMutagen(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'settings', path: 'processing' };
    const tagging = await this.settingsService.get('tagging');
    // Retag is also a manual action, but only the enabled toggle makes it unattended.
    if (tagging?.enabled !== true) return [];

    const detection = await resolveMutagenDetection();
    if (!detection) {
      return [{
        checkName: 'mutagen',
        state: 'error',
        message: 'Tag embedding is enabled but Python with the mutagen module was not found — install it or set MUTAGEN_PYTHON',
        target,
      }];
    }

    try {
      await this.deps.probeMutagen(detection.python);
      return [{ checkName: 'mutagen', state: 'healthy', target }];
    } catch {
      return [{ checkName: 'mutagen', state: 'error', message: `mutagen not usable at: ${detection.python}`, target }];
    }
  }

  private async checkHardcover(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'settings', path: 'search' };
    const metadataSettings = await this.settingsService.get('metadata');
    const apiKey = metadataSettings?.hardcoverApiKey?.trim();

    if (!apiKey) {
      return [];
    }

    try {
      // Match the settings probe: any resolved response, including an empty result, is healthy.
      await new HardcoverClient(apiKey).searchSeries('test');
      return [{ checkName: 'hardcover', state: 'healthy', target }];
    } catch (error: unknown) {
      return [{ checkName: 'hardcover', state: 'error', message: mapHardcoverError(error), target }];
    }
  }

  private async checkStuckDownloads(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'route', path: '/activity' };
    try {
      const activeDownloads = await this.db
        .select()
        .from(downloads)
        .where(inProgressDownloadCondition());

      const now = Date.now();
      const stuck = activeDownloads.filter((d) => {
        const updatedAt = d.progressUpdatedAt?.getTime() ?? d.addedAt.getTime();
        return (now - updatedAt) > ONE_HOUR_MS;
      });

      if (stuck.length > 0) {
        const names = stuck.map((d) => d.title).join(', ');
        return [{
          checkName: 'stuck-downloads',
          state: 'warning',
          message: `${stuck.length} stuck download(s): ${names}`,
          target,
        }];
      }

      return [{ checkName: 'stuck-downloads', state: 'healthy', target }];
    } catch (error: unknown) {
      return [{ checkName: 'stuck-downloads', state: 'error', message: `Failed to check downloads: ${getErrorMessage(error)}`, target }];
    }
  }

  // Updates are ambient warnings that disappear once current; omit target so the inline link is not nested in a button.
  private async checkVersionUpdate(): Promise<HealthCheckResult[]> {
    const update = getUpdateStatus();
    if (!update) return [];

    // Develop latestVersion is a bare SHA, so only stable copy receives a v-prefixed semver.
    const { message, label } = update.channel === 'develop'
      ? { message: 'A newer develop build is available', label: 'Compare changes' }
      : { message: `Update available: v${update.latestVersion}`, label: 'Release notes' };

    return [{
      checkName: 'version-update',
      state: 'warning',
      message,
      link: { url: update.releaseUrl, label },
    }];
  }
}
