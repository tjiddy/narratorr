import * as cheerio from 'cheerio';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type SearchOptions,
  type SearchResult,
} from './types.js';
import { fetchWithProxy } from './fetch.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { normalizeBaseUrl } from '../../shared/normalize-base-url.js';

export interface NewznabConfig {
  apiUrl: string; // e.g., 'https://nzbgeek.info'
  apiKey: string;
  flareSolverrUrl?: string;
  proxyUrl?: string;
}

const AUDIOBOOK_CATEGORY = '3030';

export class NewznabIndexer implements IndexerAdapter {
  readonly type = 'newznab';
  readonly name: string;

  private apiUrl: string;
  private apiKey: string;
  private flareSolverrUrl?: string;
  private proxyUrl?: string;

  constructor(config: NewznabConfig, name?: string) {
    // Normalize: strip trailing slash
    this.apiUrl = normalizeBaseUrl(config.apiUrl);
    this.apiKey = config.apiKey;
    this.flareSolverrUrl = normalizeBaseUrl(config.flareSolverrUrl);
    this.proxyUrl = config.proxyUrl;
    this.name = name || new URL(config.apiUrl).hostname;
  }

  async search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse> {
    const limit = options?.limit ?? 100;
    const params = new URLSearchParams({
      t: 'search',
      q: query,
      apikey: this.apiKey,
      cat: AUDIOBOOK_CATEGORY,
      limit: String(limit),
      attrs: 'grabs,language,group,files',
    });

    if (options?.author) {
      params.set('author', options.author);
    }

    const url = `${this.apiUrl}/api?${params.toString()}`;

    // All errors (fetch, parse, proxy) bubble up to IndexerService.searchAll()
    // which catches and logs warnings per-indexer, then continues with remaining indexers
    const fetched = await this.fetchXml(url, options?.signal);
    const parsed = this.parseSearchResults(fetched.body, limit);
    return {
      results: parsed.results,
      parseStats: parsed.parseStats,
      debugTrace: parsed.debugTrace,
      requestUrl: fetched.requestUrl,
      httpStatus: fetched.httpStatus,
    };
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string }> {
    const params = new URLSearchParams({
      t: 'caps',
      apikey: this.apiKey,
    });
    const url = `${this.apiUrl}/api?${params.toString()}`;

    try {
      const { body: xml } = await this.fetchXml(url);
      const $ = cheerio.load(xml, { xmlMode: true });
      const serverTitle = $('server').attr('title') || $('caps server').attr('title');

      const result: { success: boolean; message: string; ip?: string } = {
        success: true,
        message: serverTitle
          ? `Connected to ${serverTitle}`
          : `Connected to ${this.name}`,
      };

      if (this.proxyUrl && !this.flareSolverrUrl) {
        result.ip = await resolveProxyIp(this.proxyUrl);
      }

      return result;
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async fetchXml(url: string, signal?: AbortSignal) {
    // FlareSolverr takes precedence over standard proxy
    if (this.flareSolverrUrl) {
      return fetchWithProxy({
        url,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        proxyUrl: this.flareSolverrUrl,
        signal,
      });
    }

    return fetchWithProxyAgent(url, {
      proxyUrl: this.proxyUrl,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal,
    });
  }

  private parseSearchResults(xml: string, limit: number): { results: SearchResult[]; parseStats: IndexerSearchResponse['parseStats']; debugTrace: IndexerParseTrace[] } {
    const $ = cheerio.load(xml, { xmlMode: true });

    // Validate RSS structure — invalid/non-RSS payloads must throw, not silently return []
    if ($('rss').length === 0 && $('channel').length === 0) {
      // Check for newznab API error responses
      const apiError = $('error').attr('description') || $('error').attr('code');
      if (apiError) {
        throw new Error(`Newznab API error: ${apiError}`);
      }
      throw new Error('Invalid RSS response: missing <rss> or <channel> element');
    }

    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    const dropped = { emptyTitle: 0, noUrl: 0, other: 0 };
    let itemsObserved = 0;

    $('item').each((_, element) => {
      itemsObserved++;
      if (results.length >= limit) return false; // break

      const $item = $(element);
      const title = $item.find('title').first().text().trim();
      const guidText = $item.find('guid').text().trim() || undefined;

      if (!title) {
        dropped.emptyTitle++;
        debugTrace.push({ source: 'item', reason: 'dropped:empty-title', ...(guidText !== undefined && { guid: guidText }) });
        return; // continue
      }

      // NZB download URL: prefer enclosure url, fall back to <link>
      const downloadUrl =
        $item.find('enclosure').attr('url') ||
        $item.find('link').first().text().trim() ||
        undefined;

      if (!downloadUrl) {
        dropped.noUrl++;
        debugTrace.push({
          source: 'item',
          reason: 'dropped:no-url',
          rawTitle: title,
          rawTitleBytes: rawTitleBytesHex(title),
          guid: guidText,
        });
        return; // continue
      }

      results.push(this.buildKeptResult($item, $, title, downloadUrl, guidText));
      debugTrace.push({
        source: 'item',
        reason: 'kept',
        rawTitle: title,
        rawTitleBytes: rawTitleBytesHex(title),
        guid: guidText,
      });
    });

    return {
      results,
      parseStats: { itemsObserved, kept: results.length, dropped },
      debugTrace,
    };
  }

  private buildKeptResult(
    $item: ReturnType<cheerio.CheerioAPI>,
    $: cheerio.CheerioAPI,
    title: string,
    downloadUrl: string,
    guidText: string | undefined,
  ): SearchResult {
    const detailsUrl =
      guidText ||
      $item.find('comments').text().trim() ||
      undefined;

    const attrs = this.parseNewznabAttrs($item, $);

    const size =
      attrs.size != null
        ? Number(attrs.size)
        : Number($item.find('enclosure').attr('length')) || undefined;

    const grabsNum = attrs.grabs != null ? Number(attrs.grabs) : undefined;

    return {
      title,
      protocol: 'usenet',
      downloadUrl,
      detailsUrl,
      guid: guidText,
      size: size || undefined,
      grabs: grabsNum != null && !Number.isNaN(grabsNum) ? grabsNum : undefined,
      language: normalizeLanguage(attrs.language),
      newsgroup: attrs.group || undefined,
      indexer: this.name,
    };
  }

  private parseNewznabAttrs(
    $item: ReturnType<cheerio.CheerioAPI>,
    $: cheerio.CheerioAPI,
  ): Record<string, string> {
    const attrs: Record<string, string> = {};

    // newznab:attr elements have name and value attributes
    $item.find('newznab\\:attr, attr').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value');
      if (name && value) {
        attrs[name] = value;
      }
    });

    return attrs;
  }
}
