import * as cheerio from 'cheerio';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type SearchOptions,
  type SearchResult,
} from './types.js';
import { buildMagnetUri } from '../utils';
import { normalizeBaseUrl } from '../../shared/normalize-base-url.js';
import { fetchWithProxy } from './fetch.js';
import { isProxyRelatedError } from './errors.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';

export interface ABBConfig {
  hostname: string; // e.g., 'audiobookbay.lu'
  pageLimit: number; // Max pages to scrape per search
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

export class AudioBookBayIndexer implements IndexerAdapter {
  readonly type = 'abb';
  readonly name = 'AudioBookBay';

  private baseUrl: string;
  private userAgentIndex = 0;
  private flareSolverrUrl?: string;
  private proxyUrl?: string;

  constructor(private config: ABBConfig) {
    this.baseUrl = `https://${config.hostname}`;
    const flareSolverrUrl = normalizeBaseUrl(config.flareSolverrUrl);
    if (flareSolverrUrl !== undefined) this.flareSolverrUrl = flareSolverrUrl;
    if (config.proxyUrl !== undefined) this.proxyUrl = config.proxyUrl;
  }

  // eslint-disable-next-line complexity -- multi-page pagination with conditional-spread for transport metadata
  async search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse> {
    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    const dropped = { emptyTitle: 0, noUrl: 0, other: 0 };
    let itemsObserved = 0;
    const encodedQuery = encodeURIComponent(query.toLowerCase()).replace(/%20/g, '+');
    const limit = options?.limit || 50;
    const pageLimit = this.config.pageLimit || 2;

    let firstPageRequestUrl: string | undefined;
    let firstPageHttpStatus: number | undefined;

    for (let page = 1; page <= pageLimit; page++) {
      const url = page === 1
        ? `${this.baseUrl}/?s=${encodedQuery}&tt=1`
        : `${this.baseUrl}/page/${page}/?s=${encodedQuery}&tt=1`;

      try {
        const fetched = await this.fetchPage(url, options?.signal);
        if (page === 1) {
          firstPageRequestUrl = fetched.requestUrl;
          firstPageHttpStatus = fetched.httpStatus;
        }
        const parsed = this.parseSearchPage(fetched.body);
        itemsObserved += parsed.observed;
        dropped.emptyTitle += parsed.droppedEmptyTitle;
        debugTrace.push(...parsed.debugTrace);

        if (parsed.results.length === 0) {
          break;
        }

        const done = await this.enrichAndCollect(parsed.results, results, debugTrace, dropped, limit, options?.signal);
        if (done) {
          return {
            results,
            parseStats: { itemsObserved, kept: results.length, dropped },
            debugTrace,
            ...(firstPageRequestUrl !== undefined && { requestUrl: firstPageRequestUrl }),
            ...(firstPageHttpStatus !== undefined && { httpStatus: firstPageHttpStatus }),
          };
        }
      } catch (error: unknown) {
        if (isProxyRelatedError(error)) {
          throw error;
        }
        break;
      }
    }

    return {
      results,
      parseStats: { itemsObserved, kept: results.length, dropped },
      debugTrace,
      ...(firstPageRequestUrl !== undefined && { requestUrl: firstPageRequestUrl }),
      ...(firstPageHttpStatus !== undefined && { httpStatus: firstPageHttpStatus }),
    };
  }

  /** Fetch detail pages, enrich results, and collect those with download URLs. Returns true when limit reached. */
  private async enrichAndCollect(
    pageResults: SearchResult[],
    results: SearchResult[],
    debugTrace: IndexerParseTrace[],
    dropped: { emptyTitle: number; noUrl: number; other: number },
    limit: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const result of pageResults) {
      if (result.detailsUrl) {
        try {
          await this.delay(500);
          const detail = await this.fetchPage(result.detailsUrl, signal);
          const details = this.parseDetailPage(detail.body);
          Object.assign(result, details);
        } catch (error: unknown) {
          if (isProxyRelatedError(error)) {
            throw error;
          }
        }
      }

      if (result.downloadUrl) {
        results.push(result);
        const keptRawTitleBytes = rawTitleBytesHex(result.title);
        debugTrace.push({
          source: 'row',
          reason: 'kept',
          rawTitle: result.title,
          ...(keptRawTitleBytes !== undefined && { rawTitleBytes: keptRawTitleBytes }),
          ...(result.guid !== undefined && { guid: result.guid }),
        });
      } else {
        dropped.noUrl++;
        const droppedRawTitleBytes = rawTitleBytesHex(result.title);
        debugTrace.push({
          source: 'row',
          reason: 'dropped:no-url',
          rawTitle: result.title,
          ...(droppedRawTitleBytes !== undefined && { rawTitleBytes: droppedRawTitleBytes }),
        });
      }

      if (results.length >= limit) {
        return true;
      }
    }
    return false;
  }

  private async fetchPage(url: string, signal?: AbortSignal) {
    const headers = {
      'User-Agent': this.getNextUserAgent(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };

    // FlareSolverr takes precedence over standard proxy
    if (this.flareSolverrUrl) {
      return fetchWithProxy({ url, headers, proxyUrl: this.flareSolverrUrl, ...(signal !== undefined && { signal }) });
    }

    return fetchWithProxyAgent(url, {
      headers,
      ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
      ...(signal !== undefined && { signal }),
    });
  }

  private parseSearchPage(html: string): { results: SearchResult[]; observed: number; droppedEmptyTitle: number; debugTrace: IndexerParseTrace[] } {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    let droppedEmptyTitle = 0;

    // AudioBookBay uses various structures, try multiple selectors
    const postSelectors = [
      'div.post',
      'article.post',
      '.post-content',
      'div[class*="post"]',
    ];

    let posts = $('');
    for (const selector of postSelectors) {
      posts = $(selector);
      if (posts.length > 0) break;
    }

    posts.each((_, element) => {
      const $el = $(element);

      // Try to find the title and link
      const titleSelectors = [
        '.postTitle h2 a',
        '.postTitle a',
        'h2 a',
        'h3 a',
        '.entry-title a',
        'a[rel="bookmark"]',
      ];

      let titleEl = $('');
      for (const selector of titleSelectors) {
        titleEl = $el.find(selector).first();
        if (titleEl.length > 0) break;
      }

      const title = titleEl.text().trim();
      let detailsUrl = titleEl.attr('href');

      if (!title || !detailsUrl) {
        droppedEmptyTitle++;
        debugTrace.push({ source: 'row', reason: 'dropped:empty-title' });
        return;
      }

      // Ensure absolute URL
      if (detailsUrl && !detailsUrl.startsWith('http')) {
        detailsUrl = `${this.baseUrl}${detailsUrl.startsWith('/') ? '' : '/'}${detailsUrl}`;
      }

      // Try to find cover image
      const coverUrl = $el.find('img').first().attr('src') ||
                       $el.find('img').first().attr('data-src');

      // Try to extract metadata from the post
      const postText = $el.text();
      const author = this.extractField(postText, ['Author:', 'Written by:', 'By:']);
      const narrator = this.extractField(postText, ['Narrator:', 'Narrated by:', 'Read by:']);

      results.push({
        title,
        ...(author !== undefined && { author }),
        ...(narrator !== undefined && { narrator }),
        protocol: 'torrent',
        detailsUrl,
        ...(coverUrl !== undefined && { coverUrl }),
        indexer: this.name,
      });
    });

    return { results, observed: posts.length, droppedEmptyTitle, debugTrace };
  }

  // eslint-disable-next-line complexity -- HTML scraping with optional element extraction
  private parseDetailPage(html: string): Partial<SearchResult> {
    const $ = cheerio.load(html);
    const result: Partial<SearchResult> = {};

    // Extract info hash - it's typically displayed as plain text
    // Common patterns: "Info Hash: abc123..." or in a table
    const infoHashPatterns = [
      /Info\s*Hash[:\s]*([a-f0-9]{40})/i,
      /infohash[:\s]*([a-f0-9]{40})/i,
      /hash[:\s]*([a-f0-9]{40})/i,
      /([a-f0-9]{40})/i, // Last resort: any 40-char hex string
    ];

    // First, try to find in specific elements that commonly contain the hash
    const hashContainers = [
      'td:contains("Info Hash")',
      '.torrent-detail',
      '.info-hash',
      '#info-hash',
      'pre',
      'code',
    ];

    let foundHash = false;
    for (const container of hashContainers) {
      const text = $(container).text();
      for (const pattern of infoHashPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          result.infoHash = match[1].toLowerCase();
          foundHash = true;
          break;
        }
      }
      if (foundHash) break;
    }

    // Extract page text once for reuse
    const pageText = $('body').text();

    // If not found in specific containers, search the whole page
    if (!foundHash) {
      for (const pattern of infoHashPatterns) {
        const match = pageText.match(pattern);
        if (match && match[1]) {
          result.infoHash = match[1].toLowerCase();
          break;
        }
      }
    }

    // Build magnet URI (download URL) and set guid if we have an info hash
    if (result.infoHash) {
      result.guid = result.infoHash;
      const title = $('h1, .postTitle h2, article h2').first().text().trim();
      result.downloadUrl = buildMagnetUri(result.infoHash, title || undefined);
    }

    // Extract additional metadata from the detail page

    // Author
    if (!result.author) {
      const author = this.extractField(pageText, [
        'Author:',
        'Written by:',
        'By:',
      ]);
      if (author !== undefined) result.author = author;
    }

    // Narrator
    if (!result.narrator) {
      const narrator = this.extractField(pageText, [
        'Narrator:',
        'Narrated by:',
        'Read by:',
      ]);
      if (narrator !== undefined) result.narrator = narrator;
    }

    // Size
    const sizeMatch = pageText.match(/Size[:\s]*([\d.]+)\s*(MB|GB|TB)/i);
    if (sizeMatch?.[1] && sizeMatch[2]) {
      result.size = this.parseSize(sizeMatch[1], sizeMatch[2]);
    }

    // Try to find seeders (may not be available on ABB)
    const seedersMatch = pageText.match(/Seeders?[:\s]*(\d+)/i);
    if (seedersMatch) {
      result.seeders = parseInt(seedersMatch[1]!, 10);
    }

    const leechersMatch = pageText.match(/Leechers?[:\s]*(\d+)/i);
    if (leechersMatch) {
      result.leechers = parseInt(leechersMatch[1]!, 10);
    }

    return result;
  }

  private extractField(text: string, labels: string[]): string | undefined {
    for (const label of labels) {
      const regex = new RegExp(`${label}\\s*([^\\n]+)`, 'i');
      const match = text.match(regex);
      if (match) {
        return match[1]!.trim().replace(/^[:\s]+/, '').trim();
      }
    }
    return undefined;
  }

  private parseSize(value: string, unit: string): number {
    const num = parseFloat(value);
    const multipliers: Record<string, number> = {
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };
    return Math.round(num * (multipliers[unit.toUpperCase()] || 1));
  }

  private getNextUserAgent(): string {
    const ua = DEFAULT_USER_AGENTS[this.userAgentIndex]!;
    this.userAgentIndex = (this.userAgentIndex + 1) % DEFAULT_USER_AGENTS.length;
    return ua;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string }> {
    if (this.flareSolverrUrl) {
      return this.testViaFlareSolverr();
    }
    if (this.proxyUrl) {
      return this.testViaStandardProxy();
    }
    return this.testDirect();
  }

  private async testDirect(): Promise<{ success: boolean; message?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': this.getNextUserAgent(),
        },
        signal: controller.signal,
      });

      if (response.ok || response.status === 405) {
        // 405 Method Not Allowed is okay for HEAD requests
        return { success: true, message: `Connected to ${this.config.hostname}` };
      }

      return {
        success: false,
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async testViaFlareSolverr(): Promise<{ success: boolean; message?: string }> {
    try {
      // FlareSolverr has no request.head — use GET via request.get
      await fetchWithProxy({
        url: this.baseUrl,
        headers: { 'User-Agent': this.getNextUserAgent() },
        ...(this.flareSolverrUrl !== undefined && { proxyUrl: this.flareSolverrUrl }),
      });
      return { success: true, message: `Connected to ${this.config.hostname} via FlareSolverr` };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async testViaStandardProxy(): Promise<{ success: boolean; message?: string; ip?: string }> {
    try {
      await fetchWithProxyAgent(this.baseUrl, {
        ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
        headers: { 'User-Agent': this.getNextUserAgent() },
      });

      const ip = await resolveProxyIp(this.proxyUrl!);
      return { success: true, message: `Connected to ${this.config.hostname} via proxy`, ip };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }
}
