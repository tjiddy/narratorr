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
  nzbName?: string;
  indexer: string;
  indexerId?: number;
  indexerPriority?: number;
  detailsUrl?: string;
  guid?: string;
  coverUrl?: string;
  matchScore?: number;
  isFreeleech?: boolean;
  isVipOnly?: boolean;
}

export interface SearchOptions {
  limit?: number | undefined;
  author?: string | undefined;
  title?: string | undefined;
  signal?: AbortSignal | undefined;
  languages?: readonly string[] | undefined;
}

export interface IndexerTestResult {
  success: boolean;
  message?: string | undefined;
  ip?: string | undefined;
  warning?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Per-item parse trace produced by indexer adapters.
 * `source` is an adapter-specific origin marker:
 *   - 'item' for RSS <item> (Newznab, Torznab)
 *   - 'enclosure' for non-standard alternate-element traces
 *   - 'row' for JSON/HTML rows (MAM, ABB)
 *
 * `reason` is 'kept' for accepted items or 'dropped:<why>' for rejected ones.
 * `rawTitleBytes` is the hex of the first 32 raw-title bytes (UTF-8) and is
 * the diagnostic that lets a maintainer spot encoding issues from the log.
 */
export interface IndexerParseTrace {
  source: 'item' | 'enclosure' | 'row';
  reason: 'kept' | 'dropped:empty-title' | 'dropped:no-url' | `dropped:${string}`;
  rawTitle?: string;
  rawTitleBytes?: string;
  guid?: string;
}

export interface IndexerParseStats {
  itemsObserved: number;
  kept: number;
  dropped: { emptyTitle: number; noUrl: number; other: number };
}

export interface IndexerSearchResponse {
  results: SearchResult[];
  parseStats: IndexerParseStats;
  debugTrace: IndexerParseTrace[];
  /**
   * Optional transport metadata. Adapters with a single canonical request
   * (Newznab, Torznab, MAM) populate both. ABB scrapes multiple pages and
   * MAY populate the search-page request only, or omit both fields.
   */
  requestUrl?: string;
  httpStatus?: number;
}

export interface IndexerAdapter {
  readonly type: string;
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse>;
  test(): Promise<IndexerTestResult>;
  refreshStatus?(): Promise<{ isVip: boolean; classname: string } | null>;
}

/**
 * Compute the hex of the first `byteLimit` bytes of a string's UTF-8 encoding.
 * Returns undefined for empty input. Used by adapters to record `rawTitleBytes`
 * for the parse trace — captures encoding shape independently of how the
 * terminal renders the title.
 */
export function rawTitleBytesHex(raw: string, byteLimit = 32): string | undefined {
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'utf8').subarray(0, byteLimit);
  return buf.toString('hex');
}
