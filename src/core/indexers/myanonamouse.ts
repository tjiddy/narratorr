import type { IndexerAdapter, SearchOptions, SearchResult } from './types.js';
import { IndexerAuthError, ProxyError } from './errors.js';
import { createProxyAgent, resolveProxyIp } from './proxy.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { MAM_LANGUAGES } from '../../shared/indexer-registry.js';

export interface MAMConfig {
  mamId: string;
  baseUrl?: string;
  proxyUrl?: string;
  searchLanguages: number[];
  searchType: string;
  isVip?: boolean;
}

const DEFAULT_BASE_URL = 'https://www.myanonamouse.net';
const REQUEST_TIMEOUT_MS = 30_000;

interface MAMSearchResponse {
  error?: string;
  data?: MAMSearchResult[];
}

interface MAMSearchResult {
  id?: number;
  title?: string;
  author_info?: string;
  narrator_info?: string;
  series_info?: string;
  lang_code?: string;
  size?: string | number;
  seeders?: number;
  leechers?: number;
  free?: boolean;
  fl_vip?: boolean;
  vip?: boolean;
  personal_freeleech?: boolean;
}

/**
 * Parse a double-encoded JSON field from MAM responses.
 * Fields like author_info are JSON strings containing JSON objects.
 * e.g. "{\"123\": \"Brandon Sanderson\"}" → "Brandon Sanderson"
 * Returns undefined on any parse failure.
 */
function parseDoubleEncodedNames(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    const firstParse: unknown = JSON.parse(raw);
    if (typeof firstParse !== 'string') {
      // Already an object from single parse — extract values
      if (firstParse && typeof firstParse === 'object') {
        const values = Object.values(firstParse as Record<string, string>);
        return values.length > 0 ? values.join(', ') : undefined;
      }
      return undefined;
    }

    // Second parse: the string should be a JSON object
    const secondParse: unknown = JSON.parse(firstParse);
    if (secondParse && typeof secondParse === 'object') {
      const values = Object.values(secondParse as Record<string, string>);
      return values.length > 0 ? values.join(', ') : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.proxyUrl = config.proxyUrl;
    this.searchLanguages = config.searchLanguages;
    this.searchType = config.searchType;
    this.isVip = config.isVip;
    this.name = name || 'MyAnonamouse';
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
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

    const url = `${this.baseUrl}/tor/js/loadSearchJSONbasic.php?${params.toString()}`;
    const body = await this.fetchWithCookie(url, options?.signal);

    // Check for auth failure in response body
    if (body.includes('Error, you are not signed in')) {
      throw new IndexerAuthError(this.name, 'Authentication failed — check your MAM ID');
    }

    let response: MAMSearchResponse;
    try {
      response = JSON.parse(body) as MAMSearchResponse;
    } catch {
      throw new Error('MAM returned invalid JSON response');
    }

    // "Nothing returned, out of ..." is an empty-result message, not an error
    if (response.error && response.error.startsWith('Nothing returned')) {
      return [];
    }

    if (response.error) {
      throw new Error(`MAM search error: ${response.error}`);
    }

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    return this.buildResults(response.data, options?.signal);
  }

  private async buildResults(data: MAMSearchResult[], signal?: AbortSignal): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    for (const item of data) {
      if (!item.title) continue;

      let downloadUrl: string | undefined;
      if (item.id != null) {
        downloadUrl = await this.fetchTorrentAsDataUri(item.id, signal);
      }

      const isFreeleech = item.free || item.personal_freeleech || (item.fl_vip && this.isVip);
      const isVipOnly = item.vip;

      results.push({
        title: item.title,
        author: parseDoubleEncodedNames(item.author_info),
        narrator: parseDoubleEncodedNames(item.narrator_info),
        protocol: 'torrent',
        guid: item.id != null ? String(item.id) : undefined,
        downloadUrl,
        size: this.parseSize(item.size),
        seeders: item.seeders ?? undefined,
        leechers: item.leechers ?? undefined,
        language: normalizeLanguage(item.lang_code),
        indexer: this.name,
        isFreeleech: isFreeleech || undefined,
        isVipOnly: isVipOnly || undefined,
      });
    }

    return results;
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string; warning?: string; metadata?: Record<string, unknown> }> {
    try {
      const body = await this.fetchWithCookie(`${this.baseUrl}/jsonLoad.php`);

      if (body.includes('Error, you are not signed in')) {
        return { success: false, message: 'Authentication failed — check your MAM ID' };
      }

      let data: { username?: string; classname?: string };
      try {
        data = JSON.parse(body) as { username?: string; classname?: string };
      } catch {
        return { success: false, message: 'MAM returned invalid response' };
      }

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
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  async refreshStatus(): Promise<{ isVip: boolean; classname: string } | null> {
    const body = await this.fetchWithCookie(`${this.baseUrl}/jsonLoad.php`);

    let data: { username?: string; classname?: string };
    try {
      data = JSON.parse(body) as { username?: string; classname?: string };
    } catch {
      return null;
    }

    if (!data.classname) {
      return null;
    }

    const isVip = data.classname === 'VIP' || data.classname === 'Elite VIP';
    this.isVip = isVip;

    return { isVip, classname: data.classname };
  }

  /**
   * Fetch a URL with the mam_id cookie for authentication.
   * Throws on HTTP 403 with an auth-specific error message.
   */
  private async fetchWithCookie(url: string, callerSignal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    const dispatcher = createProxyAgent(this.proxyUrl);

    try {
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal,
      };

      if (dispatcher) {
        (fetchOptions as Record<string, unknown>).dispatcher = dispatcher;
      }

      let response: Response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (error: unknown) {
        if (dispatcher) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ProxyError(`Proxy timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
          }
          const msg = error instanceof Error ? error.message : 'unknown error';
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

      return await response.text();
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
      .filter((id): id is number => id !== undefined);
  }

  /**
   * Parse a MAM size field (e.g. "881.8 MiB", "1.1 GiB") into bytes.
   * Returns undefined for zero, unparseable strings, or unknown units.
   * Numeric values pass through unchanged (future-proofing).
   * Illustrative captured MAM values: "881.8 MiB", "1.1 GiB", "830.0 MiB".
   */
  private parseSize(raw: string | number | undefined): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'number') return raw || undefined;

    const parts = raw.trim().split(' ');
    if (parts.length !== 2) return undefined;

    const num = parseFloat(parts[0]);
    if (!num || !isFinite(num)) return undefined;

    const multipliers: Record<string, number> = {
      KIB: 1024,
      MIB: 1024 * 1024,
      GIB: 1024 * 1024 * 1024,
      TIB: 1024 * 1024 * 1024 * 1024,
    };

    const multiplier = multipliers[parts[1].toUpperCase()];
    if (!multiplier) return undefined;

    return Math.round(num * multiplier);
  }

  /**
   * Fetch .torrent file bytes and encode as a data: URI.
   * Returns undefined on failure (result is kept but not grabbable).
   */
  private async fetchTorrentAsDataUri(torrentId: number, callerSignal?: AbortSignal): Promise<string | undefined> {
    const url = `${this.baseUrl}/tor/download.php?tid=${torrentId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    const dispatcher = createProxyAgent(this.proxyUrl);

    try {
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal,
      };

      if (dispatcher) {
        (fetchOptions as Record<string, unknown>).dispatcher = dispatcher;
      }

      let response: Response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (error: unknown) {
        // Proxy errors must propagate — not be swallowed as undefined
        if (dispatcher) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ProxyError(`Proxy timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
          }
          const msg = error instanceof Error ? error.message : 'unknown error';
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
