import type { DownloadProtocol } from '@shared/schemas/download-protocol.js';
import type { UnsatisfiedStatus } from '../utils/mam-unsatisfied.js';

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
  /**
   * Audio bitrate in KILObits per second, always an integer >= 1. Absence is unknown — the
   * indexers that report it also report `?`/`Variable`, which fold to absence rather than to 0.
   * Named for its unit: the repo also carries bitrate in bps (`books.audio_bitrate`), and the two
   * must never be compared. Display only; no gate or ranking arm reads it.
   */
  bitrateKbps?: number;
  /**
   * The unsatisfied allowance the source indexer reported for THIS search, attached where
   * indexerId is stamped. Request-scoped telemetry, never stored: absence is the fail-open
   * state, so an unannotated result is never blocked. Only MAM reports it.
   */
  unsatisfied?: UnsatisfiedStatus;
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
  /**
   * The same punctuation-cleaned query as the positional `query`, but with apostrophes kept.
   * Only an adapter whose index cannot match a de-apostrophized token may read it (today: ABB,
   * whose tokenizer treats the apostrophe as a word character, #2422). Every other adapter uses
   * the positional `query` argument, so its request is unaffected by this field's presence.
   */
  queryWithApostrophes?: string | undefined;
}

export interface IndexerTestResult {
  success: boolean;
  message?: string | undefined;
  ip?: string | undefined;
  warning?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Per-item parse outcome; rawTitleBytes preserves UTF-8 shape for encoding diagnostics.
 *
 * The four failure fields currently have no producer: #2420 moved ABB detail fetching to the
 * grab seam, where a failure throws IndexerError (warned by resolveAdapterDownloadUrl) instead
 * of emitting a trace. They stay for the next adapter that records per-row transport failures.
 */
export interface IndexerParseTrace {
  source: 'item' | 'enclosure' | 'row';
  reason: 'kept' | 'dropped:empty-title' | 'dropped:no-url' | `dropped:${string}`;
  rawTitle?: string;
  rawTitleBytes?: string;
  guid?: string;
  errorMessage?: string;
  errorCode?: string;
  httpStatus?: number;
  /** The request that failed, not the search request the response as a whole reports. */
  requestUrl?: string;
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
  /**
   * Independently observed status groups. `isVip`/`classname` derive from one MAM field and are
   * both present or both absent; `unsatisfied` is present only as a validated pair. `null` means
   * neither group was observed.
   */
  refreshStatus?(signal?: AbortSignal): Promise<{ isVip?: boolean; classname?: string; unsatisfied?: UnsatisfiedStatus } | null>;
  /** Resolve an adapter sentinel to its real grab URL; MAM may also request a freeleech wedge. */
  resolveDownloadUrl?(ctx: ResolveDownloadContext): Promise<ResolveDownloadResult>;
}

/** Hex-encode the first UTF-8 bytes for render-independent title diagnostics. */
export function rawTitleBytesHex(raw: string, byteLimit = 32): string | undefined {
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'utf8').subarray(0, byteLimit);
  return buf.toString('hex');
}
