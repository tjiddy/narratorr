export interface TorrentInfo {
  id: string;
  name: string;
  hash: string;
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

export interface AddTorrentOptions {
  savePath?: string;
  category?: string;
  paused?: boolean;
}

export interface DownloadClientAdapter {
  readonly type: string;
  readonly name: string;

  addTorrent(magnetOrUrl: string, options?: AddTorrentOptions): Promise<string>;
  getTorrent(id: string): Promise<TorrentInfo | null>;
  getAllTorrents(category?: string): Promise<TorrentInfo[]>;
  pauseTorrent(id: string): Promise<void>;
  resumeTorrent(id: string): Promise<void>;
  removeTorrent(id: string, deleteFiles?: boolean): Promise<void>;
  test(): Promise<{ success: boolean; message?: string }>;
}
