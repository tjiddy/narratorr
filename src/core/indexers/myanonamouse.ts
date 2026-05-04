import { z } from 'zod';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type SearchOptions,
  type SearchResult,
} from './types.js';
import { IndexerAuthError, IndexerError, ProxyError } from './errors.js';
import { createProxyAgent, resolveProxyIp } from './proxy.js';
import { fetchWithOptionalDispatcher, type DispatcherFetchInit } from '../utils/network-service.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { MAM_LANGUAGES } from '../../shared/indexer-registry.js';
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
}

const DEFAULT_BASE_URL = 'https://www.myanonamouse.net';
import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';

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

  constructor(config: MAMConfig, name?: string) {
    this.mamId = config.mamId;
    this.baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
    if (config.proxyUrl !== undefined) this.proxyUrl = config.proxyUrl;
    this.searchLanguages = config.searchLanguages;
    this.searchType = config.searchType;
    if (config.isVip !== undefined) this.isVip = config.isVip;
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

    const built = await this.buildResults(response.data, options?.signal);
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

  private async buildResults(data: MAMSearchResult[], signal?: AbortSignal): Promise<{ results: SearchResult[]; parseStats: IndexerSearchResponse['parseStats']; debugTrace: IndexerParseTrace[] }> {
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

      let downloadUrl: string | undefined;
      if (item.id != null) {
        downloadUrl = await this.fetchTorrentAsDataUri(item.id, signal);
      }

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
        const result: { success: boolean; message: string; ip?: string; warning?: string; metadata: Record<string, unknown> } = {
          success: true,
          message: `Connected as ${data.username}`,
          metadata: { username: data.username, classname: data.classname, isVip },
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
