import { writeFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadClientAdapter, DownloadItemInfo, DownloadArtifact, DownloadProtocol } from './types.js';
import { createSsrfSafeDispatcher, fetchWithSsrfRedirect, mapNetworkError, redactUrlsFromMessage } from '../utils/network-service.js';
import { DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { getErrorMessage } from '@shared/error-message.js';
import { getUserAgent } from '@shared/user-agent.js';

export interface BlackholeConfig {
  watchDir: string;
  protocol: DownloadProtocol;
}

export class BlackholeClient implements DownloadClientAdapter {
  readonly type = 'blackhole';
  readonly name = 'Blackhole';
  readonly protocol: DownloadProtocol;
  readonly supportsCategories = false;

  constructor(private config: BlackholeConfig) {
    this.protocol = config.protocol;
  }

  async addDownload(artifact: DownloadArtifact): Promise<null> {
    const timestamp = Date.now();

    if (artifact.type === 'torrent-bytes') {
      const filePath = join(this.config.watchDir, `download-${timestamp}.torrent`);
      await writeFile(filePath, artifact.data);
      return null;
    }

    if (artifact.type === 'magnet-uri') {
      const filePath = join(this.config.watchDir, `${timestamp}.magnet`);
      await writeFile(filePath, artifact.uri);
      return null;
    }

    if (artifact.type === 'nzb-bytes') {
      if (artifact.data.length === 0) {
        throw new DownloadClientError(this.name, 'Cannot add empty NZB file');
      }
      const filePath = join(this.config.watchDir, `download-${timestamp}.nzb`);
      await writeFile(filePath, artifact.data);
      return null;
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
      const filePath = join(this.config.watchDir, `download-${timestamp}.nzb`);
      await writeFile(filePath, buffer);

      return null;
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
      await access(this.config.watchDir, constants.R_OK | constants.W_OK);
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
