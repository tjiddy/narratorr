export interface SearchResult {
  title: string;
  author?: string;
  narrator?: string;
  infoHash?: string;
  magnetUri?: string;
  torrentUrl?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  indexer: string;
  detailsUrl?: string;
  coverUrl?: string;
}

export interface SearchOptions {
  limit?: number;
  author?: string;
}

export interface IndexerAdapter {
  readonly type: string;
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  test(): Promise<{ success: boolean; message?: string }>;
}
