import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { downloads } from '../../db/schema.js';
import { and, inArray } from 'drizzle-orm';
import type { IndexerService } from './indexer.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import { getInProgressStatuses } from '../../shared/download-status-registry.js';
import { getErrorMessage } from '../utils/error-message.js';
import { mapHardcoverError } from '../utils/hardcover-error.js';
import { HardcoverClient } from '../../core/metadata/hardcover.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';
import { getUpdateStatus, checkForUpdate } from '../jobs/version-check.js';


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
  resolveProxyIp: (proxyUrl: string) => Promise<string>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export class HealthCheckService {
  private previousStates: Map<string, HealthState> = new Map();
  private cachedResults: HealthCheckResult[] = [];
  private running = false;
  private pendingRerun = false;
  private versionUpdateCallback?: () => void;
  // Callers that coalesce into an in-flight pass park here and are resolved with
  // the result of the *next* full pass — the guaranteed trailing rerun, which
  // begins after they registered. This is what lets the manual "Run Now" path
  // (#1411) observe its freshly-fetched version cache even when it overlaps an
  // active scheduled pass, instead of getting the pre-fetch `cachedResults`.
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

  /**
   * Recompute every health check and store the result for the cached-read
   * endpoints. Overlapping requests coalesce: a call that lands while a pass is
   * already running sets `pendingRerun` and the active pass runs exactly one
   * trailing recompute after it finishes, so the latest state (e.g. a freshly-
   * cached version update from a manual/boot version-check) is always observed —
   * never silently dropped. The trailing rerun is bounded to a single pass per
   * overlapping request (no unbounded loop), and only fires when a request lands
   * during an active pass, so non-overlapping scheduled cron runs are untouched.
   *
   * A coalesced caller resolves with the result of that guaranteed trailing
   * rerun — a pass that *begins after the caller registered* — not with the
   * pre-existing `cachedResults`. This is load-bearing for the manual "Run Now"
   * path (#1411): `runManualChecks` awaits the live version fetch before calling
   * `runAllChecks`, so the trailing rerun it awaits reads the post-fetch cache.
   * Returning `cachedResults` immediately here would hand the route a report
   * computed before the fetch resolved, violating AC #1's deterministic-freshness
   * contract whenever the manual run overlaps a scheduled pass.
   */
  async runAllChecks(): Promise<HealthCheckResult[]> {
    if (this.running) {
      this.pendingRerun = true;
      // Park until the next full pass completes; that pass starts after this
      // call (pendingRerun guarantees the active loop iterates again), so the
      // result reflects any state visible now.
      return new Promise<HealthCheckResult[]>((resolve) => {
        this.trailingWaiters.push(resolve);
      });
    }
    this.running = true;

    try {
      let results: HealthCheckResult[];
      do {
        this.pendingRerun = false;
        // Capture the waiters registered before this iteration started; this
        // pass's result satisfies exactly them. Waiters that arrive mid-pass go
        // into a fresh list and are served by the next iteration (which their
        // own `pendingRerun = true` guarantees) — so every coalesced caller gets
        // a pass that began strictly after it registered.
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

  /**
   * Register the version-update health-nudge callback owned by the boot/2 AM
   * version-check invocations (jobs/index.ts `onUpdateChanged`). The manual
   * "Run Now" path (`runManualChecks`) passes this *same* callback into
   * `checkForUpdate`, so its SSE/health-nudge side-effects stay identical to the
   * scheduled path (#1411, AC #5). Set once during `startJobs`; left undefined in
   * contexts that don't boot jobs (e.g. route tests), in which case the manual
   * run simply fires no nudge callback — harmless, the awaited fetch still
   * freshens the cache.
   */
  setVersionUpdateCallback(callback: () => void): void {
    this.versionUpdateCallback = callback;
  }

  /**
   * Manual "Run Now" entry point: live-refresh the version-update cache *before*
   * reading the health report, then run a full pass. The version-update row is
   * otherwise a pure cache read (`checkVersionUpdate` → `getUpdateStatus`) fed
   * only by the daily 2 AM version-check job, so a manual run could surface an
   * up-to-24h-stale row presenting with the same freshness as the live-probed
   * rows (#1411).
   *
   * Ordering is serial and deterministic: `checkForUpdate` is awaited to
   * completion (bounded by its own 10s `AbortSignal.timeout`) before
   * `runAllChecks` reads `getUpdateStatus` mid-pass, so the returned report
   * always reflects the post-fetch cache — never a pre-fetch stale result. This
   * holds even when the manual run overlaps an active scheduled pass: the
   * `runAllChecks` call coalesces and resolves with the guaranteed trailing
   * rerun, which begins after this fetch resolved (see `runAllChecks`).
   *
   * Best-effort: `checkForUpdate` already swallows all fetch/parse errors and
   * resolves `void`; the defensive `.catch` is a contract guard so a hung or
   * rejecting check never fails the health run — it falls through to the existing
   * cached value. The scheduled `health-check` cron calls `runAllChecks` directly
   * and pays no fetch cost (AC #3).
   */
  async runManualChecks(log: FastifyBaseLogger): Promise<HealthCheckResult[]> {
    await checkForUpdate(log, this.versionUpdateCallback).catch((error: unknown) => {
      log.error({ error: serializeError(error) }, 'Manual health run: live version check failed');
    });
    return this.runAllChecks();
  }

  /** Run one full pass of every check and fire state-transition notifications. */
  private async runChecksOnce(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    // Run all checks independently — one failure doesn't prevent others
    const checks = [
      () => this.checkIndexers(),
      () => this.checkDownloadClients(),
      () => this.checkLibraryRoot(),
      () => this.checkDiskSpace(),
      () => this.checkFfmpeg(),
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

    // Fire notifications for state transitions
    for (const result of results) {
      const previousState = this.previousStates.get(result.checkName) ?? 'healthy';
      if (previousState !== result.state) {
        fireAndForget(
          this.notifierService.notify('on_health_issue', {
            event: 'on_health_issue',
            health: {
              checkName: result.checkName,
              previousState,
              currentState: result.state,
              message: result.message,
            },
          }),
          this.log,
          'Failed to send health issue notification',
        );
      }
      this.previousStates.set(result.checkName, result.state);
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

  /** Probe ffmpeg binary at given path. Returns version string on success. */
  async probeFfmpeg(path: string): Promise<string> {
    return this.deps.probeFfmpeg(path);
  }

  /** Resolve proxy IP by making a request through the proxy. */
  async probeProxy(proxyUrl: string): Promise<string> {
    return this.deps.resolveProxyIp(proxyUrl);
  }

  /** Reset state tracking for tests */
  _reset(): void {
    this.previousStates.clear();
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
      // Check both read and write access (R_OK=4, W_OK=2)
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
    const target: HealthCheckTarget = { kind: 'settings', path: 'post-processing' };
    const processingSettings = await this.settingsService.get('processing');
    const ffmpegPath = processingSettings?.ffmpegPath;

    if (!ffmpegPath?.trim()) {
      return []; // Skip check if not configured
    }

    try {
      await this.deps.probeFfmpeg(ffmpegPath);
      return [{ checkName: 'ffmpeg', state: 'healthy', target }];
    } catch {
      return [{ checkName: 'ffmpeg', state: 'error', message: `ffmpeg not found at: ${ffmpegPath}`, target }];
    }
  }

  private async checkHardcover(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'settings', path: 'search' };
    const metadataSettings = await this.settingsService.get('metadata');
    const apiKey = metadataSettings?.hardcoverApiKey?.trim();

    if (!apiKey) {
      return []; // Skip check if no Hardcover API key is configured
    }

    try {
      // Live probe — same request the settings Test button uses. An empty
      // results array is still success; resolving without throwing is the signal.
      await new HardcoverClient(apiKey).searchSeries('test');
      return [{ checkName: 'hardcover', state: 'healthy', target }];
    } catch (error: unknown) {
      return [{ checkName: 'hardcover', state: 'error', message: mapHardcoverError(error), target }];
    }
  }

  private async checkStuckDownloads(): Promise<HealthCheckResult[]> {
    const target: HealthCheckTarget = { kind: 'route', path: '/activity' };
    try {
      const inProgressStatuses = getInProgressStatuses();
      const activeDownloads = await this.db
        .select()
        .from(downloads)
        .where(
          and(
            inArray(downloads.status, inProgressStatuses),
          )
        );

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

  /**
   * Surfaces an available app update as an ambient `warning` (an outdated
   * version is a mild degradation, not an error). The row clears on its own
   * once the running version catches up to latest.
   * No `target` is set: the dashboard renders the release-notes `link` inline,
   * and leaving `target` unset keeps the card out of the clickable-button path
   * (no nested interactive controls).
   */
  private async checkVersionUpdate(): Promise<HealthCheckResult[]> {
    const update = getUpdateStatus();
    if (!update) return []; // No newer version cached — omit the row entirely.

    // Channel-aware copy: stable renders the semver + release notes; develop
    // renders generic build wording + a compare-diff link (the develop
    // `latestVersion` is a bare sha, never `v`-prefixed into the message).
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
