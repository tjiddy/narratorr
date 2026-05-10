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
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';


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

  constructor(
    private indexerService: IndexerService,
    private downloadClientService: DownloadClientService,
    private settingsService: SettingsService,
    private notifierService: NotifierService,
    private db: Db,
    private log: FastifyBaseLogger,
    private deps: SystemDeps,
  ) {}

  async runAllChecks(): Promise<HealthCheckResult[]> {
    if (this.running) return this.cachedResults;
    this.running = true;

    try {
      const results: HealthCheckResult[] = [];

      // Run all checks independently — one failure doesn't prevent others
      const checks = [
        () => this.checkIndexers(),
        () => this.checkDownloadClients(),
        () => this.checkLibraryRoot(),
        () => this.checkDiskSpace(),
        () => this.checkFfmpeg(),
        () => this.checkStuckDownloads(),
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

      this.cachedResults = results;
      return results;
    } finally {
      this.running = false;
    }
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
}
