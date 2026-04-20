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
  eta?: number; // Seconds
  /**
   * Current download rate in bytes/sec.
   * `undefined` means the client did not report a rate; `0` means the download is
   * active but currently stalled (zero throughput). Consumers must distinguish these.
   */
  downloadSpeed?: number;
  addedAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

export interface AddDownloadOptions {
  savePath?: string;
  category?: string;
  paused?: boolean;
}

export interface DownloadClientAdapter {
  readonly type: string;
  readonly name: string;
  readonly protocol: DownloadProtocol;
  readonly supportsCategories: boolean;

  /**
   * Send a pre-resolved download artifact to the client. Returns the external ID for tracking.
   * Only the Blackhole adapter returns `null` (no external tracking system);
   * all other adapters return a string ID or throw on failure.
   */
  addDownload(artifact: DownloadArtifact, options?: AddDownloadOptions): Promise<string | null>;
  getDownload(id: string): Promise<DownloadItemInfo | null>;
  getAllDownloads(category?: string): Promise<DownloadItemInfo[]>;
  getCategories(): Promise<string[]>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  removeDownload(id: string, deleteFiles?: boolean): Promise<void>;
  test(): Promise<{ success: boolean; message?: string }>;
}
