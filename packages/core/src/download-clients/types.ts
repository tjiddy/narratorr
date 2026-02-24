import type { DownloadProtocol } from '../indexers/types.js';

export type { DownloadProtocol } from '../indexers/types.js';

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
  addedAt: Date;
  completedAt?: Date;
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

  addDownload(url: string, options?: AddDownloadOptions): Promise<string>;
  getDownload(id: string): Promise<DownloadItemInfo | null>;
  getAllDownloads(category?: string): Promise<DownloadItemInfo[]>;
  getCategories(): Promise<string[]>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  removeDownload(id: string, deleteFiles?: boolean): Promise<void>;
  test(): Promise<{ success: boolean; message?: string }>;
}
