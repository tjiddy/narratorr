import { writeFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadClientAdapter, DownloadItemInfo, DownloadArtifact, DownloadProtocol } from './types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';

export interface BlackholeConfig {
  watchDir: string;
  protocol: DownloadProtocol;
}

const REQUEST_TIMEOUT_MS = 30000;

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

    // nzb-url — fetch the URL and write the bytes
    let response: Response;
    try {
      response = await fetchWithTimeout(artifact.url, {}, REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      if (isTimeoutError(error)) throw new DownloadClientTimeoutError(this.name, (error as Error).message);
      throw new DownloadClientError(this.name, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new DownloadClientError(this.name, `Failed to download file: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = join(this.config.watchDir, `download-${timestamp}.nzb`);
    await writeFile(filePath, buffer);

    return null;
  }

  async getDownload(_id: string): Promise<DownloadItemInfo | null> {
    // Blackhole has no progress monitoring
    return null;
  }

  async getAllDownloads(_category?: string): Promise<DownloadItemInfo[]> {
    return [];
  }

  async pauseDownload(_id: string): Promise<void> {
    // No-op
  }

  async resumeDownload(_id: string): Promise<void> {
    // No-op
  }

  async removeDownload(_id: string, _deleteFiles?: boolean): Promise<void> {
    // No-op — file already handed off to external client
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message };
    }
  }

}
