import type { IndexerAdapter, SearchResult } from './types.js';
import { IndexerAuthError } from './errors.js';

export interface MAMConfig {
  mamId: string;
  baseUrl?: string;
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
  size?: number;
  seeders?: number;
  leechers?: number;
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

  constructor(config: MAMConfig, name?: string) {
    this.mamId = config.mamId;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.name = name || 'MyAnonamouse';
  }

  async search(query: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      'tor[text]': query,
      'tor[srchIn][title]': 'true',
      'tor[srchIn][author]': 'true',
      'tor[main_cat][]': '13',
    });

    const url = `${this.baseUrl}/tor/js/loadSearchJSONbasic.php?${params.toString()}`;
    const body = await this.fetchWithCookie(url);

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

    const results: SearchResult[] = [];
    for (const item of response.data) {
      if (!item.title) continue;

      let downloadUrl: string | undefined;
      if (item.id != null) {
        downloadUrl = await this.fetchTorrentAsDataUri(item.id);
      }

      results.push({
        title: item.title,
        author: parseDoubleEncodedNames(item.author_info),
        narrator: parseDoubleEncodedNames(item.narrator_info),
        protocol: 'torrent',
        downloadUrl,
        size: item.size ?? undefined,
        seeders: item.seeders ?? undefined,
        leechers: item.leechers ?? undefined,
        indexer: this.name,
      });
    }

    return results;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const body = await this.fetchWithCookie(`${this.baseUrl}/jsonLoad.php`);

      if (body.includes('Error, you are not signed in')) {
        return { success: false, message: 'Authentication failed — check your MAM ID' };
      }

      let data: { username?: string };
      try {
        data = JSON.parse(body) as { username?: string };
      } catch {
        return { success: false, message: 'MAM returned invalid response' };
      }

      if (data.username) {
        return { success: true, message: `Connected as ${data.username}` };
      }

      return { success: false, message: 'Authentication failed — check your MAM ID' };
    } catch (error) {
      if (error instanceof IndexerAuthError) {
        return { success: false, message: error.message };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * Fetch a URL with the mam_id cookie for authentication.
   * Throws on HTTP 403 with an auth-specific error message.
   */
  private async fetchWithCookie(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal: controller.signal,
      });

      if (response.status === 403) {
        throw new IndexerAuthError(this.name, 'Authentication failed — check your MAM ID');
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
  private async fetchTorrentAsDataUri(torrentId: number): Promise<string | undefined> {
    const url = `${this.baseUrl}/tor/download.php?tid=${torrentId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Cookie: `mam_id=${this.mamId}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`MAM torrent fetch failed for tid=${torrentId}: HTTP ${response.status}`);
        return undefined;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:application/x-bittorrent;base64,${buffer.toString('base64')}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`MAM torrent fetch failed for tid=${torrentId}: ${msg}`);
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
