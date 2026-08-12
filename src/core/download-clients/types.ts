import type { DownloadProtocol } from '../indexers/types.js';
import type { DownloadArtifact } from '../utils/download-url.js';

export type { DownloadProtocol } from '../indexers/types.js';
export type { DownloadArtifact } from '../utils/download-url.js';

/** ETA values >= this (in seconds) are treated as "no ETA available". */
export const ETA_UPPER_BOUND_SEC = 8640000;

export interface DownloadItemInfo {
  id: string;
  name: string;
  progress: number; // 0-100
  status: 'downloading' | 'seeding' | 'paused' | 'completed' | 'error';
  savePath: string;
  size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  seeders: number;
  leechers: number;
  eta?: number | undefined; // Seconds
  /** Bytes/sec; undefined is unreported, while zero is a reported stall. */
  downloadSpeed?: number | undefined;
  addedAt: Date;
  completedAt?: Date | undefined;
  errorMessage?: string | undefined;
}

export interface AddDownloadOptions {
  savePath?: string | undefined;
  category?: string | undefined;
  paused?: boolean | undefined;
}

export interface DownloadClientAdapter {
  readonly type: string;
  readonly name: string;
  readonly protocol: DownloadProtocol;
  readonly supportsCategories: boolean;

  /** Return the tracking ID; Blackhole alone returns null because it has no control channel. */
  addDownload(artifact: DownloadArtifact, options?: AddDownloadOptions): Promise<string | null>;
  getDownload(id: string): Promise<DownloadItemInfo | null>;
  getAllDownloads(category?: string): Promise<DownloadItemInfo[]>;
  getCategories(): Promise<string[]>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  removeDownload(id: string, deleteFiles?: boolean): Promise<void>;
  test(): Promise<{ success: boolean; message?: string }>;
}
