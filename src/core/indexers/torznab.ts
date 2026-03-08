import * as cheerio from 'cheerio';
import type { IndexerAdapter, SearchResult, SearchOptions } from './types.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { fetchWithProxy } from './fetch.js';
import { isProxyRelatedError } from './errors.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';

export interface TorznabConfig {
  apiUrl: string; // e.g., 'https://jackett.example.com/api/v2.0/indexers/mytracker/results/torznab'
  apiKey: string;
  flareSolverrUrl?: string;
  proxyUrl?: string;
}

const AUDIOBOOK_CATEGORY = '3030';

export class TorznabIndexer implements IndexerAdapter {
  readonly type = 'torznab';
  readonly name: string;

  private apiUrl: string;
  private apiKey: string;
  private flareSolverrUrl?: string;
  private proxyUrl?: string;

  constructor(config: TorznabConfig, name?: string) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.flareSolverrUrl = config.flareSolverrUrl?.replace(/\/+$/, '');
    this.proxyUrl = config.proxyUrl;
    this.name = name || new URL(config.apiUrl).hostname;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 100;
    const params = new URLSearchParams({
      t: 'search',
      q: query,
      apikey: this.apiKey,
      cat: AUDIOBOOK_CATEGORY,
      limit: String(limit),
    });

    if (options?.author) {
      params.set('author', options.author);
    }

    const url = `${this.apiUrl}/api?${params.toString()}`;

    try {
      const xml = await this.fetchXml(url);
      return this.parseSearchResults(xml, limit);
    } catch (error) {
      // Proxy errors bubble up to IndexerService.searchAll() for warn logging
      if (isProxyRelatedError(error)) {
        throw error;
      }
      return [];
    }
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string }> {
    const params = new URLSearchParams({
      t: 'caps',
      apikey: this.apiKey,
    });
    const url = `${this.apiUrl}/api?${params.toString()}`;

    try {
      const xml = await this.fetchXml(url);
      const $ = cheerio.load(xml, { xmlMode: true });
      const serverTitle = $('server').attr('title') || $('caps server').attr('title');

      const result: { success: boolean; message: string; ip?: string } = {
        success: true,
        message: serverTitle
          ? `Connected to ${serverTitle}`
          : `Connected to ${this.name}`,
      };

      // Resolve exit IP when using a standard proxy
      if (this.proxyUrl && !this.flareSolverrUrl) {
        result.ip = await resolveProxyIp(this.proxyUrl);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private async fetchXml(url: string): Promise<string> {
    // FlareSolverr takes precedence over standard proxy
    if (this.flareSolverrUrl) {
      return fetchWithProxy({
        url,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        proxyUrl: this.flareSolverrUrl,
      });
    }

    return fetchWithProxyAgent(url, {
      proxyUrl: this.proxyUrl,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    });
  }

  private parseSearchResults(xml: string, limit: number): SearchResult[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const results: SearchResult[] = [];

    // eslint-disable-next-line complexity -- XML item parsing with optional attribute extraction
    $('item').each((_, element) => {
      if (results.length >= limit) return false; // break

      const $item = $(element);
      const title = $item.find('title').first().text().trim();
      if (!title) return; // continue

      const attrs = this.parseNewznabAttrs($item, $);

      // Torrent download URL: prefer enclosure, fall back to <link>, fall back to magnet
      const infoHash = attrs.infohash || undefined;
      let downloadUrl =
        $item.find('enclosure').attr('url') ||
        $item.find('link').first().text().trim() ||
        undefined;

      // If no direct download URL but we have an infoHash, build a magnet URI
      if (!downloadUrl && infoHash) {
        downloadUrl = buildMagnetUri(infoHash, title);
      }

      const detailsUrl =
        $item.find('guid').text().trim() ||
        $item.find('comments').text().trim() ||
        undefined;

      const size =
        attrs.size != null
          ? Number(attrs.size)
          : Number($item.find('enclosure').attr('length')) || undefined;

      results.push({
        title,
        protocol: 'torrent',
        downloadUrl,
        detailsUrl,
        infoHash,
        size: size || undefined,
        seeders: attrs.seeders != null ? Number(attrs.seeders) : undefined,
        leechers: attrs.leechers != null ? Number(attrs.leechers) : undefined,
        grabs: attrs.grabs != null ? Number(attrs.grabs) : undefined,
        indexer: this.name,
      });
    });

    return results;
  }

  private parseNewznabAttrs(
    $item: ReturnType<cheerio.CheerioAPI>,
    $: cheerio.CheerioAPI,
  ): Record<string, string> {
    const attrs: Record<string, string> = {};

    $item.find('newznab\\:attr, torznab\\:attr, attr').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value');
      if (name && value) {
        attrs[name] = value;
      }
    });

    return attrs;
  }
}
