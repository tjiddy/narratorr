export type DownloadProtocol = 'torrent' | 'usenet';

export interface SearchResult {
  title: string;
  rawTitle?: string;
  author?: string;
  narrator?: string;
  protocol: DownloadProtocol;
  downloadUrl?: string;
  infoHash?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  language?: string;
  newsgroup?: string;
  indexer: string;
  indexerId?: number;
  detailsUrl?: string;
  guid?: string;
  coverUrl?: string;
  matchScore?: number;
  isFreeleech?: boolean;
  isVipOnly?: boolean;
}

export interface SearchOptions {
  limit?: number;
  author?: string;
  title?: string;
  signal?: AbortSignal;
  languages?: readonly string[];
}

export interface IndexerAdapter {
  readonly type: string;
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  test(): Promise<{ success: boolean; message?: string; ip?: string; warning?: string; metadata?: Record<string, unknown> }>;
  refreshStatus?(): Promise<{ isVip: boolean; classname: string } | null>;
}
