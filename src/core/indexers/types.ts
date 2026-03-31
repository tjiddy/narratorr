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
  indexer: string;
  indexerId?: number;
  detailsUrl?: string;
  guid?: string;
  coverUrl?: string;
  matchScore?: number;
}

export interface SearchOptions {
  limit?: number;
  author?: string;
  title?: string;
}

export interface IndexerAdapter {
  readonly type: string;
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  test(): Promise<{ success: boolean; message?: string }>;
}
