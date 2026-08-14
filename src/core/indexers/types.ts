import type { DownloadProtocol } from '@shared/schemas/download-protocol.js';

export type { DownloadProtocol };

export interface SearchResult {
  title: string;
  rawTitle?: string;
  author?: string;
  narrator?: string;
  protocol: DownloadProtocol;
  downloadUrl?: string;
  infoHash?: string;
  size?: number;
  /** Indexer's human-readable size string; diagnostic only, so a mangled parse is legible in the log. */
  rawSize?: string;
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
  /** Lowercase MAM container. Absence is unknown, not mp3; display only. */
  format?: string;
}

export interface SearchOptions {
  limit?: number | undefined;
  /** Newznab/Torznab transport filter; relaxation clears it but retains rankingAuthor. */
  author?: string | undefined;
  title?: string | undefined;
  signal?: AbortSignal | undefined;
  languages?: readonly string[] | undefined;
  /** Ranking-only author context. Adapters must ignore it; scoring falls back to author. */
  rankingAuthor?: string | undefined;
}

export interface IndexerTestResult {
  success: boolean;
  message?: string | undefined;
  ip?: string | undefined;
  warning?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** Per-item parse outcome; rawTitleBytes preserves UTF-8 shape for encoding diagnostics. */
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
  /** Canonical request metadata; ABB may report only its search request or omit both. */
  requestUrl?: string;
  httpStatus?: number;
}

/** Grab context; guid mirrors optional GrabParams.guid and callers normalize isFreeleech. */
export interface ResolveDownloadContext {
  guid?: string;
  downloadUrl: string;
  protocol: DownloadProtocol;
  isFreeleech: boolean;
}

export interface ResolveDownloadResult {
  downloadUrl: string;
  /** MAM only: freeleech was requested server-side, not necessarily applied. */
  wedgeRequested?: boolean;
}

export interface IndexerAdapter {
  readonly type: string;
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse>;
  test(): Promise<IndexerTestResult>;
  refreshStatus?(): Promise<{ isVip: boolean; classname: string } | null>;
  /** Resolve an adapter sentinel to its real grab URL; MAM may also request a freeleech wedge. */
  resolveDownloadUrl?(ctx: ResolveDownloadContext): Promise<ResolveDownloadResult>;
}

/** Hex-encode the first UTF-8 bytes for render-independent title diagnostics. */
export function rawTitleBytesHex(raw: string, byteLimit = 32): string | undefined {
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'utf8').subarray(0, byteLimit);
  return buf.toString('hex');
}
