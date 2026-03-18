import { writeFile, access, constants } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { DownloadClientAdapter, DownloadItemInfo, AddDownloadOptions, DownloadProtocol } from './types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

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

  async addDownload(url: string, options?: AddDownloadOptions): Promise<null> {
    // Torrent file path — write bytes directly to watch directory
    if (options?.torrentFile) {
      const ext = this.config.protocol === 'usenet' ? '.nzb' : '.torrent';
      const filename = `download-${Date.now()}${ext}`;
      const filePath = join(this.config.watchDir, filename);
      await writeFile(filePath, options.torrentFile);
      return null;
    }

    const response = await fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = this.resolveFilename(url);
    const filePath = join(this.config.watchDir, filename);

    await writeFile(filePath, buffer);

    // No external ID — Blackhole downloads are not tracked
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('ENOENT')) {
        return { success: false, message: `Watch directory does not exist: ${this.config.watchDir}` };
      }
      if (message.includes('EACCES')) {
        return { success: false, message: `Watch directory is not writable: ${this.config.watchDir}` };
      }
      return { success: false, message };
    }
  }

  private resolveFilename(url: string): string {
    try {
      const parsed = new URL(url);
      const pathBasename = basename(parsed.pathname);
      if (pathBasename && (pathBasename.endsWith('.torrent') || pathBasename.endsWith('.nzb'))) {
        return pathBasename;
      }
    } catch {
      // Not a valid URL — fall through
    }

    // Default extension based on protocol
    const ext = this.config.protocol === 'usenet' ? '.nzb' : '.torrent';
    const timestamp = Date.now();
    return `download-${timestamp}${ext}`;
  }
}
