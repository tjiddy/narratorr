import { writeFile, rename, unlink, access, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DownloadClientAdapter, DownloadItemInfo, DownloadArtifact, DownloadProtocol, StagedHandoff } from './types.js';
import { createSsrfSafeDispatcher, fetchWithSsrfRedirect, mapNetworkError, redactUrlsFromMessage } from '../utils/network-service.js';
import { DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { getErrorMessage } from '@shared/error-message.js';
import { getUserAgent } from '@shared/user-agent.js';

export interface BlackholeConfig {
  watchDir: string;
  protocol: DownloadProtocol;
}

/** Windows-only failure family: MoveFileEx rejects while the destination is mid-replace by a
 *  concurrent rename or briefly held by a watcher. POSIX rename replaces atomically, so the
 *  retry path is never entered on Linux (#2396). */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES']);
const RENAME_RETRY_LIMIT = 5;
const RENAME_RETRY_BASE_DELAY_MS = 15;

async function renameWithTransientRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_LIMIT) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BASE_DELAY_MS * attempt));
    }
  }
}

/**
 * The rename is the publish, so it is also the only defensible commit point. Neither half logs:
 * `src/core` adapters throw, and the server catch that receives the rejection owns the record.
 */
function stagedHandoff(tempPath: string, finalPath: string): StagedHandoff {
  let published = false;
  return {
    async commit(): Promise<void> {
      if (published) return;
      await renameWithTransientRetry(tempPath, finalPath);
      published = true;
    },
    async abort(): Promise<void> {
      try {
        await unlink(tempPath);
      } catch (error: unknown) {
        // Never created, already discarded, or already published — the artifact is gone either way.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    },
  };
}

export class BlackholeClient implements DownloadClientAdapter {
  readonly type = 'blackhole';
  readonly name = 'Blackhole';
  readonly protocol: DownloadProtocol;
  readonly supportsCategories = false;

  constructor(private config: BlackholeConfig) {
    this.protocol = config.protocol;
  }

  /**
   * Write to a temp name a watching client ignores; only the caller's commit renames it into
   * place. The temp basename carries its own random component so that every in-flight handoff
   * stages to a distinct path, independent of how the final name is built.
   */
  private async stageArtifactFile(finalName: string, data: Parameters<typeof writeFile>[1]): Promise<StagedHandoff> {
    const finalPath = join(this.config.watchDir, finalName);
    const tempPath = join(this.config.watchDir, `.narratorr-${randomUUID()}.part`);
    await writeFile(tempPath, data);
    return stagedHandoff(tempPath, finalPath);
  }

  /** Publish immediately; a caller that needs a durable record first stages and commits itself. */
  async addDownload(artifact: DownloadArtifact): Promise<null> {
    const staged = await this.stageDownload(artifact);
    // No abort on a failed commit: a failed rename leaves the temp file, as it always has.
    await staged.commit();
    return null;
  }

  async stageDownload(artifact: DownloadArtifact): Promise<StagedHandoff> {
    const timestamp = Date.now();
    // #2482: the timestamp alone collides for two handoffs in the same millisecond — coarser than it
    // looks on Windows, where Date.now() quantizes to ~15.6ms — and the loser is silently replaced
    // after its download row already landed. Never hoist this: one UUID per invocation is the fix.
    const unique = randomUUID();

    if (artifact.type === 'torrent-bytes') {
      return this.stageArtifactFile(`download-${timestamp}-${unique}.torrent`, artifact.data);
    }

    // No `download-` prefix here, unlike every other type: watcher-facing and deliberate.
    if (artifact.type === 'magnet-uri') {
      return this.stageArtifactFile(`${timestamp}-${unique}.magnet`, artifact.uri);
    }

    if (artifact.type === 'nzb-bytes') {
      if (artifact.data.length === 0) {
        throw new DownloadClientError(this.name, 'Cannot add empty NZB file');
      }
      return this.stageArtifactFile(`download-${timestamp}-${unique}.nzb`, artifact.data);
    }

    // Follow indexer redirects through SSRF validation. The configured-host allowlist
    // admits LAN indexers without opening arbitrary private addresses.
    const dispatcher = createSsrfSafeDispatcher(artifact.lanAllowlist?.hostname);
    try {
      let response: Response;
      try {
        response = await fetchWithSsrfRedirect(artifact.url, {
          dispatcher,
          headers: { 'User-Agent': getUserAgent() },
          ...(artifact.lanAllowlist && { lanAllowlist: artifact.lanAllowlist.hostPort }),
        });
      } catch (error: unknown) {
        // This helper propagates raw errors; map first so timeout classification survives.
        const mapped = mapNetworkError(error);
        if (isTimeoutError(mapped)) throw new DownloadClientTimeoutError(this.name, mapped.message);
        // Unmapped messages may contain passkey/API-key URLs.
        throw new DownloadClientError(this.name, redactUrlsFromMessage(mapped.message));
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => { /* best-effort */ });
        throw new DownloadClientError(this.name, `Failed to download file: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // Awaited inside the try so the dispatcher is closed before the handle reaches the caller.
      return await this.stageArtifactFile(`download-${timestamp}-${unique}.nzb`, buffer);
    } finally {
      await dispatcher.close().catch(() => { /* best-effort cleanup */ });
    }
  }

  async getDownload(_id: string): Promise<DownloadItemInfo | null> {
    return null;
  }

  async getAllDownloads(_category?: string): Promise<DownloadItemInfo[]> {
    return [];
  }

  async pauseDownload(_id: string): Promise<void> {
    // No-op.
  }

  async resumeDownload(_id: string): Promise<void> {
    // No-op.
  }

  async removeDownload(_id: string, _deleteFiles?: boolean): Promise<void> {
    // File was already handed off; there is no external control channel.
  }

  async getCategories(): Promise<string[]> {
    return [];
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      // X_OK too: a writable-but-non-searchable directory passes W_OK and then fails every
      // actual write with EACCES, so without it this probe lies in the one case it guards (#2503).
      await access(this.config.watchDir, constants.R_OK | constants.W_OK | constants.X_OK);
      return { success: true, message: `Watch directory exists and is writable: ${this.config.watchDir}` };
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === 'ENOENT') {
        return { success: false, message: `Watch directory does not exist: ${this.config.watchDir}` };
      }
      if (code === 'EACCES') {
        return { success: false, message: `Watch directory is not writable: ${this.config.watchDir}` };
      }
      return { success: false, message: getErrorMessage(error) };
    }
  }

}
