import { z } from 'zod';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type ResolveDownloadContext,
  type ResolveDownloadResult,
  type SearchOptions,
  type SearchResult,
  type WedgeOutcome,
} from './types.js';
import { IndexerAuthError, IndexerError, ProxyError } from './errors.js';
import { createProxyAgent, resolveProxyIp } from './proxy.js';
import { fetchWithOptionalDispatcher, type DispatcherFetchInit } from '../utils/network-service.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { MAM_LANGUAGES } from '../../shared/indexer-registry.js';
import type { WedgeMode } from '../../shared/schemas/indexer.js';
import { getErrorMessage, getErrorMessageWithCause } from '../../shared/error-message.js';
import { normalizeBaseUrl } from '../../shared/normalize-base-url.js';
import { parseDoubleEncodedNames, parseMamSize } from './mam-helpers.js';

export interface MAMConfig {
  mamId: string;
  baseUrl?: string | undefined;
  proxyUrl?: string | undefined;
  searchLanguages: number[];
  searchType: string;
  isVip?: boolean | undefined;
  useFreeleechWedge?: WedgeMode | undefined;
  minWedgeReserve?: number | undefined;
}

const DEFAULT_BASE_URL = 'https://www.myanonamouse.net';
import { INDEXER_TIMEOUT_MS, WEDGE_FETCH_TIMEOUT_MS } from '../utils/constants.js';

/** Sentinel prefix used as `SearchResult.downloadUrl` for MAM results — the real torrent is fetched at grab time. */
const MAM_TORRENT_SENTINEL_PREFIX = 'mam-torrent://';
const MAM_SENTINEL_PATTERN = /^mam-torrent:\/\/(\d+)$/;

// MAM (and many PHP-backend APIs) emit boolean flag fields as 0/1 integers
// rather than JSON booleans. Accept both shapes and normalize to boolean.
const numericBoolean = z.union([z.boolean(), z.number()])
  .transform((v) => (typeof v === 'number' ? v !== 0 : v));

const mamSearchResultSchema = z.object({
  id: z.number().nullish(),
  title: z.string().nullish(),
  author_info: z.string().nullish(),
  narrator_info: z.string().nullish(),
  series_info: z.string().nullish(),
  lang_code: z.string().nullish(),
  size: z.union([z.string(), z.number()]).nullish(),
  seeders: z.number().nullish(),
  leechers: z.number().nullish(),
  free: numericBoolean.nullish(),
  fl_vip: numericBoolean.nullish(),
  vip: numericBoolean.nullish(),
  personal_freeleech: numericBoolean.nullish(),
}).passthrough();

// MAM search responses always carry either `data` (results array, possibly empty)
// or `error` (a message). A response with neither is malformed (e.g. HTML
// interstitial, rate-limit page, upstream API change) and must fail validation
// rather than silently producing an empty result list.
const mamSearchResponseSchema = z.object({
  error: z.string().nullish(),
  data: z.array(mamSearchResultSchema).nullish(),
}).passthrough().refine(
  (d) => d.error != null || d.data != null,
  { message: 'MAM search response missing both "data" and "error" fields' },
);

const mamUserStatusSchema = z.object({
  username: z.string().nullish(),
  classname: z.string().nullish(),
  wedges: z.number().nullish(),
}).passthrough();

const mamBonusBuyResponseSchema = z.object({
  success: z.boolean().nullish(),
  error: z.string().nullish(),
}).passthrough();

type MAMSearchResult = z.infer<typeof mamSearchResultSchema>;

function orUndef<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export class MyAnonamouseIndexer implements IndexerAdapter {
  readonly type = 'myanonamouse';
  readonly name: string;
  private baseUrl: string;
  private mamId: string;
  private proxyUrl?: string;
  private searchLanguages: number[];
  private searchType: string;
  private isVip?: boolean;
  private useFreeleechWedge: WedgeMode;
  private minWedgeReserve: number;

  constructor(config: MAMConfig, name?: string) {
    this.mamId = config.mamId;
    this.baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
    if (config.proxyUrl !== undefined) this.proxyUrl = config.proxyUrl;
    this.searchLanguages = config.searchLanguages;
    this.searchType = config.searchType;
    if (config.isVip !== undefined) this.isVip = config.isVip;
    this.useFreeleechWedge = config.useFreeleechWedge ?? 'never';
    this.minWedgeReserve = config.minWedgeReserve ?? 0;
    this.name = name || 'MyAnonamouse';
  }

  async search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse> {
    const url = this.buildSearchUrl(query, options);
    const fetched = await this.fetchWithCookieMeta(url, options?.signal);
    const response = this.parseSearchBody(fetched.body);

    // "Nothing returned, out of ..." is an empty-result message, not an error
    if (response.error && response.error.startsWith('Nothing returned')) {
      return {
        results: [],
        parseStats: { itemsObserved: 0, kept: 0, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
        debugTrace: [],
        requestUrl: url,
        httpStatus: fetched.httpStatus,
      };
    }

    if (response.error) {
      throw new IndexerError(this.name, `MAM search error: ${response.error}`);
    }

    if (!response.data) {
      return {
        results: [],
        parseStats: { itemsObserved: 0, kept: 0, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
        debugTrace: [],
        requestUrl: url,
        httpStatus: fetched.httpStatus,
      };
    }

    const built = this.buildResults(response.data);
    return {
      results: built.results,
      parseStats: built.parseStats,
      debugTrace: built.debugTrace,
      requestUrl: url,
      httpStatus: fetched.httpStatus,
    };
  }

  private buildSearchUrl(query: string, options?: SearchOptions): string {
    const params = new URLSearchParams({
      'tor[text]': query,
      'tor[srchIn][title]': 'true',
      'tor[srchIn][author]': 'true',
      'tor[main_cat][]': '13',
    });

    // Auto-select search type based on VIP status, fall back to saved value for legacy rows
    const effectiveSearchType = this.isVip === true ? 'all' : this.isVip === false ? 'nVIP' : this.searchType;
    params.set('tor[searchType]', effectiveSearchType);

    // Append language filter parameters from per-search options
    const langIds = this.mapLanguagesToMamIds(options?.languages);
    for (let i = 0; i < langIds.length; i++) {
      params.set(`tor[browse_lang][${i}]`, String(langIds[i]));
    }

    return `${this.baseUrl}/tor/js/loadSearchJSONbasic.php?${params.toString()}`;
  }

  private parseSearchBody(body: string): z.infer<typeof mamSearchResponseSchema> {
    if (body.includes('Error, you are not signed in')) {
      throw new IndexerAuthError(this.name, 'Authentication failed — check your MAM ID');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      throw new IndexerError(this.name, 'MAM returned invalid JSON response', { cause: err instanceof Error ? err : undefined });
    }

    const parsed = mamSearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new IndexerError(
        this.name,
        `MAM returned unexpected search response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private buildResults(data: MAMSearchResult[]): { results: SearchResult[]; parseStats: IndexerSearchResponse['parseStats']; debugTrace: IndexerParseTrace[] } {
    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    const dropped = { emptyTitle: 0, noUrl: 0, other: 0 };

    for (const item of data) {
      const guid = item.id != null ? String(item.id) : undefined;
      if (!item.title) {
        dropped.emptyTitle++;
        debugTrace.push({ source: 'row', reason: 'dropped:empty-title', ...(guid !== undefined && { guid }) });
        continue;
      }

      // Emit a sentinel download URL — the real torrent bytes are fetched lazily
      // by `resolveDownloadUrl` at grab time so the optional freeleech wedge can
      // be applied first.
      const downloadUrl = item.id != null ? `${MAM_TORRENT_SENTINEL_PREFIX}${item.id}` : undefined;
      const rawBytes = rawTitleBytesHex(item.title);
      if (!downloadUrl) {
        dropped.noUrl++;
        debugTrace.push({ source: 'row', reason: 'dropped:no-url', rawTitle: item.title, ...(rawBytes !== undefined && { rawTitleBytes: rawBytes }), ...(guid !== undefined && { guid }) });
        continue;
      }
      results.push(this.mapItem(item, downloadUrl));
      debugTrace.push({ source: 'row', reason: 'kept', rawTitle: item.title, ...(rawBytes !== undefined && { rawTitleBytes: rawBytes }), ...(guid !== undefined && { guid }) });
    }

    return {
      results,
      parseStats: { itemsObserved: data.length, kept: results.length, dropped },
      debugTrace,
    };
  }

  private mapItem(item: MAMSearchResult, downloadUrl: string | undefined): SearchResult {
    const isFreeleech = item.free || item.personal_freeleech || (item.fl_vip && this.isVip);
    const isVipOnly = item.vip;

    const author = parseDoubleEncodedNames(orUndef(item.author_info));
      const narrator = parseDoubleEncodedNames(orUndef(item.narrator_info));
      const guid = item.id != null ? String(item.id) : undefined;
      const size = parseMamSize(orUndef(item.size));
      const seeders = orUndef(item.seeders);
      const leechers = orUndef(item.leechers);
      const language = normalizeLanguage(orUndef(item.lang_code));
      return {
      title: item.title!,
      ...(author !== undefined && { author }),
      ...(narrator !== undefined && { narrator }),
      protocol: 'torrent',
      ...(guid !== undefined && { guid }),
      ...(downloadUrl !== undefined && { downloadUrl }),
    ...(size !== undefined && { size }),
    ...(seeders !== undefined && { seeders }),
    ...(leechers !== undefined && { leechers }),
    ...(language !== undefined && { language }),
    indexer: this.name,
    ...(isFreeleech && { isFreeleech: true }),
    ...(isVipOnly && { isVipOnly: true }),
    };
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string; warning?: string; metadata?: Record<string, unknown> }> {
    try {
      const body = await this.fetchWithCookie(`${this.baseUrl}/jsonLoad.php`);

      if (body.includes('Error, you are not signed in')) {
        return { success: false, message: 'Authentication failed — check your MAM ID' };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch (err) {
        throw new IndexerError(this.name, 'MAM returned invalid JSON response', { cause: err instanceof Error ? err : undefined });
      }

      const parsed = mamUserStatusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new IndexerError(
          this.name,
          `MAM returned unexpected user-status response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      const data = parsed.data;

      if (data.username) {
        const isVip = data.classname === 'VIP' || data.classname === 'Elite VIP';
        const wedges = typeof data.wedges === 'number' ? data.wedges : undefined;
        const result: { success: boolean; message: string; ip?: string; warning?: string; metadata: Record<string, unknown> } = {
          success: true,
          message: `Connected as ${data.username}`,
          metadata: { username: data.username, classname: data.classname, isVip, ...(wedges !== undefined && { wedges }) },
        };

        if (data.classname === 'Mouse') {
          result.warning = 'Account is ratio-locked (Mouse class) — cannot download';
        }

        if (this.proxyUrl) {
          result.ip = await resolveProxyIp(this.proxyUrl);
        }

        return result;
      }

      return { success: false, message: 'Authentication failed — check your MAM ID' };
    } catch (error: unknown) {
      if (error instanceof IndexerAuthError) {
        return { success: false, message: error.message };
      }
      if (error instanceof IndexerError) {
        return { success: false, message: error.message };
      }
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  async refreshStatus(): Promise<{ isVip: boolean; classname: string } | null> {
    try {
      const body = await this.fetchWithCookie(`${this.baseUrl}/jsonLoad.php`);

      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch (err) {
        throw new IndexerError(this.name, 'MAM returned invalid JSON response', { cause: err instanceof Error ? err : undefined });
      }

      const parsed = mamUserStatusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new IndexerError(
          this.name,
          `MAM returned unexpected user-status response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      const data = parsed.data;

      if (!data.classname) {
        return null;
      }

      const isVip = data.classname === 'VIP' || data.classname === 'Elite VIP';
      this.isVip = isVip;

      return { isVip, classname: data.classname };
    } catch (error: unknown) {
      if (error instanceof IndexerError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch a URL with the mam_id cookie for authentication.
   * Throws on HTTP 403 with an auth-specific error message.
   */
  private async fetchWithCookie(url: string, callerSignal?: AbortSignal): Promise<string> {
    const { body } = await this.fetchWithCookieMeta(url, callerSignal);
    return body;
  }

  private async fetchWithCookieMeta(url: string, callerSignal?: AbortSignal): Promise<{ body: string; httpStatus: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    const dispatcher = createProxyAgent(this.proxyUrl);

    try {
      const fetchOptions: DispatcherFetchInit = {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal,
        dispatcher,
      };

      let response: Response;
      try {
        response = await fetchWithOptionalDispatcher(url, fetchOptions);
      } catch (error: unknown) {
        if (dispatcher) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ProxyError(`Proxy timed out after ${Math.round(INDEXER_TIMEOUT_MS / 1000)}s`);
          }
          const msg = getErrorMessageWithCause(error);
          throw new ProxyError(`Proxy connection failed: ${msg}`);
        }
        throw error;
      }

      if (response.status === 403) {
        const body = await response.text();
        const match = body.match(/<br \/>\s*(.+)/);
        const detail = match?.[1]?.trim();
        throw new IndexerAuthError(
          this.name,
          detail ? `Authentication failed — ${detail}` : 'Authentication failed — check your MAM ID',
        );
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const body = await response.text();
      return { body, httpStatus: response.status };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Map canonical language names to MAM numeric IDs.
   * Falls back to cached per-indexer searchLanguages if no per-search languages provided.
   * Names without a MAM ID mapping are silently skipped.
   */
  private mapLanguagesToMamIds(languages?: readonly string[]): number[] {
    if (languages === undefined) {
      return this.searchLanguages;
    }
    if (languages.length === 0) {
      return [];
    }
    const nameToId = new Map(MAM_LANGUAGES.map((l) => [l.label.toLowerCase(), l.id]));
    return languages
      .map((name) => nameToId.get(name.toLowerCase()))
      .filter((id) => id !== undefined);
  }


  /**
   * Grab-time hook. Optionally spends a freeleech wedge based on configured
   * mode + reserve floor, then fetches the torrent bytes. Returns the data URL
   * plus a typed `wedgeOutcome` for the service layer to log. Throws
   * `IndexerError` when (a) Required-mode and the spend decision failed, or
   * (b) the torrent fetch itself failed (uniform contract — both modes).
   */
  async resolveDownloadUrl(ctx: ResolveDownloadContext): Promise<ResolveDownloadResult> {
    const tid = parseTorrentIdFromContext(ctx);
    if (tid === undefined) {
      throw new IndexerError(this.name, `MAM resolveDownloadUrl: unable to derive torrent id from guid=${ctx.guid ?? 'undefined'} url=${ctx.downloadUrl}`);
    }

    const wedgeOutcome = await this.decideWedgeSpend(tid, ctx.isFreeleech);
    // In Required mode, a failed spend decision aborts the grab without
    // touching the torrent endpoint.
    if (this.useFreeleechWedge === 'required' && isWedgeFailureOutcome(wedgeOutcome)) {
      throw new IndexerError(this.name, `MAM wedge spend failed in Required mode (${wedgeOutcome}) for tid=${tid}`, { wedgeOutcome });
    }

    return this.fetchTorrentForResolve(tid, wedgeOutcome);
  }

  private async fetchTorrentForResolve(tid: number, wedgeOutcome: WedgeOutcome): Promise<ResolveDownloadResult> {
    let downloadUrl: string | undefined;
    try {
      downloadUrl = await this.fetchTorrentAsDataUri(tid);
    } catch (error: unknown) {
      throw new IndexerError(
        this.name,
        `MAM torrent fetch failed for tid=${tid}: ${getErrorMessage(error)}`,
        { cause: error instanceof Error ? error : undefined, wedgeOutcome },
      );
    }
    if (!downloadUrl) {
      throw new IndexerError(this.name, `MAM torrent fetch returned no data for tid=${tid}`, { wedgeOutcome });
    }
    return { downloadUrl, wedgeOutcome };
  }

  /**
   * Decide whether to spend a freeleech wedge. Returns a typed outcome on every
   * non-throwing path. Throws only when the underlying fetch path raises in
   * Required mode AND `fetchWithCookieMeta` propagates (which it does for
   * `ProxyError`); the caller wraps to ensure uniform contract.
   */
  private async decideWedgeSpend(tid: number, ctxIsFreeleech: boolean): Promise<WedgeOutcome> {
    if (this.useFreeleechWedge === 'never') return 'skipped-mode-never';
    if (ctxIsFreeleech) return 'skipped-already-free';

    let currentWedges: number;
    try {
      currentWedges = await this.fetchCurrentWedges();
    } catch {
      return 'skipped-fetch-failed';
    }

    if (currentWedges - this.minWedgeReserve < 1) {
      return 'skipped-no-inventory';
    }

    return this.spendWedge(tid);
  }

  private async fetchCurrentWedges(): Promise<number> {
    const url = `${this.baseUrl}/jsonLoad.php`;
    const body = await this.fetchWithCookieTimeout(url, WEDGE_FETCH_TIMEOUT_MS);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      throw new IndexerError(this.name, 'MAM returned invalid JSON for wedge status', { cause: err instanceof Error ? err : undefined });
    }
    const parsed = mamUserStatusSchema.safeParse(raw);
    if (!parsed.success || typeof parsed.data.wedges !== 'number') {
      throw new IndexerError(this.name, 'MAM user-status response missing numeric wedges field');
    }
    return parsed.data.wedges;
  }

  private async spendWedge(tid: number): Promise<WedgeOutcome> {
    const ts = Math.floor(Date.now() / 1000);
    const url = `${this.baseUrl}/json/bonusBuy.php/${ts}?spendtype=personalFL&torrentid=${tid}&timestamp=${ts}`;
    let body: string;
    try {
      body = await this.postWithCookieTimeout(url, WEDGE_FETCH_TIMEOUT_MS);
    } catch {
      return 'failed-spend';
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return 'failed-spend';
    }
    const parsed = mamBonusBuyResponseSchema.safeParse(raw);
    if (!parsed.success) return 'failed-spend';

    if (parsed.data.success === true) return 'spent';
    const error = parsed.data.error ?? '';
    if (error.includes('This Torrent is VIP')) return 'skipped-already-vip';
    if (error.includes('This is already a personal freeleech')) return 'skipped-idempotent';
    return 'failed-spend';
  }

  /** GET variant of `fetchWithCookieMeta` with a configurable timeout. */
  private async fetchWithCookieTimeout(url: string, timeoutMs: number): Promise<string> {
    return this.fetchWithCookieMethod(url, 'GET', timeoutMs);
  }

  /** POST variant of `fetchWithCookieMeta` with a configurable timeout. */
  private async postWithCookieTimeout(url: string, timeoutMs: number): Promise<string> {
    return this.fetchWithCookieMethod(url, 'POST', timeoutMs);
  }

  private async fetchWithCookieMethod(url: string, method: 'GET' | 'POST', timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const dispatcher = createProxyAgent(this.proxyUrl);
    try {
      const fetchOptions: DispatcherFetchInit = {
        method,
        headers: { Cookie: `mam_id=${this.mamId}` },
        signal: controller.signal,
        dispatcher,
      };
      let response: Response;
      try {
        response = await fetchWithOptionalDispatcher(url, fetchOptions);
      } catch (error: unknown) {
        if (dispatcher) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
          }
          const msg = getErrorMessageWithCause(error);
          throw new ProxyError(`Proxy connection failed: ${msg}`);
        }
        throw error;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch .torrent file bytes and encode as a data: URI.
   * Returns undefined on failure (result is kept but not grabbable).
   */
  private async fetchTorrentAsDataUri(torrentId: number, callerSignal?: AbortSignal): Promise<string | undefined> {
    const url = `${this.baseUrl}/tor/download.php?tid=${torrentId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    const dispatcher = createProxyAgent(this.proxyUrl);

    try {
      const fetchOptions: DispatcherFetchInit = {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal,
        dispatcher,
      };

      let response: Response;
      try {
        response = await fetchWithOptionalDispatcher(url, fetchOptions);
      } catch (error: unknown) {
        // Proxy errors must propagate — not be swallowed as undefined
        if (dispatcher) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ProxyError(`Proxy timed out after ${Math.round(INDEXER_TIMEOUT_MS / 1000)}s`);
          }
          const msg = getErrorMessageWithCause(error);
          throw new ProxyError(`Proxy connection failed: ${msg}`);
        }
        throw error;
      }

      if (!response.ok) {
        return undefined;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:application/x-bittorrent;base64,${buffer.toString('base64')}`;
    } catch (error: unknown) {
      // ProxyError must propagate up — not be swallowed
      if (error instanceof ProxyError) {
        throw error;
      }
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Derive the MAM torrent id from the resolve context. Prefers `guid` (when
 * the dispatch path supplied it), else parses the `mam-torrent://{tid}`
 * sentinel emitted by `search()`.
 */
function parseTorrentIdFromContext(ctx: ResolveDownloadContext): number | undefined {
  if (ctx.guid !== undefined) {
    const n = Number(ctx.guid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const match = MAM_SENTINEL_PATTERN.exec(ctx.downloadUrl);
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

function isWedgeFailureOutcome(outcome: WedgeOutcome): boolean {
  return outcome === 'skipped-no-inventory' || outcome === 'skipped-fetch-failed' || outcome === 'failed-spend';
}
