import * as cheerio from 'cheerio';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type ResolveDownloadContext,
  type ResolveDownloadResult,
  type SearchOptions,
  type SearchResult,
} from './types.js';
import { buildMagnetUri } from '../utils';
import { readAbbMetadata } from './abb-fields.js';
import { buildAbbQuery } from './abb-query.js';
import { inlineReAbPosts } from './abb-re-ab.js';
import { abbDetailsSentinel, parseAbbDetailsUrl } from './abb-sentinel.js';
import { abbThrottle, acquireAbbSolverMutex } from './abb-throttle.js';
import { normalizeBaseUrl } from '@shared/normalize-base-url.js';
import { fetchWithProxy, type FetchResult } from './fetch.js';
import { IndexerError, isProxyRelatedError } from './errors.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { describeSolverFailure } from './solver-diagnosis.js';
import { getErrorMessage } from '@shared/error-message.js';
import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';

export interface ABBConfig {
  hostname: string; // Hostname only, e.g. audiobookbay.lu.
  pageLimit: number;
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

/**
 * One pinned UA for every ABB request. Rotating four of them from a single IP is a bot fingerprint,
 * not camouflage — no real browser changes identity between page loads — and it is part of what
 * earned the 2026-08 ban. audiobookbay-automated pins one Chrome UA for the same reason.
 */
const ABB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': ABB_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

export class AudioBookBayIndexer implements IndexerAdapter {
  readonly type = 'abb';
  readonly name = 'AudioBookBay';

  private baseUrl: string;
  private flareSolverrUrl?: string;
  private proxyUrl?: string;

  constructor(private config: ABBConfig) {
    this.baseUrl = `https://${config.hostname}`;
    const flareSolverrUrl = normalizeBaseUrl(config.flareSolverrUrl);
    if (flareSolverrUrl !== undefined) this.flareSolverrUrl = flareSolverrUrl;
    if (config.proxyUrl !== undefined) this.proxyUrl = config.proxyUrl;
  }

  /**
   * Search-page requests only. A detail fetch per row — up to 50 of them — is what earned the ban,
   * and both mature community integrations (Jackett, audiobookbay-automated) resolve the magnet at
   * download time instead; `resolveDownloadUrl` is that half.
   */
  async search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse> {
    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    const dropped = { emptyTitle: 0, noUrl: 0, other: 0 };
    let itemsObserved = 0;
    // The positional query has already had its apostrophes deleted, so the fold only has something
    // to remove when the service handed down the apostrophe-bearing form (#2422).
    const foldedQuery = buildAbbQuery(options?.queryWithApostrophes ?? query);
    const encodedQuery = encodeURIComponent(foldedQuery.toLowerCase()).replace(/%20/g, '+');
    const limit = options?.limit || 50;
    const pageLimit = this.config.pageLimit || 2;

    // The canonical request metadata the response reports; both halves come from one fetch, so they
    // are present or absent together.
    let firstPage: { requestUrl: string; httpStatus: number } | undefined;

    for (let page = 1; page <= pageLimit; page++) {
      const url = page === 1
        ? `${this.baseUrl}/?s=${encodedQuery}&tt=1`
        : `${this.baseUrl}/page/${page}/?s=${encodedQuery}&tt=1`;

      try {
        const fetched = await this.fetchPage(url, options?.signal);
        if (page === 1) {
          firstPage = { requestUrl: fetched.requestUrl, httpStatus: fetched.httpStatus };
        }
        const parsed = this.parseSearchPage(fetched.body);
        itemsObserved += parsed.observed;
        dropped.emptyTitle += parsed.droppedEmptyTitle;
        dropped.other += parsed.droppedOther;
        debugTrace.push(...parsed.debugTrace);

        if (parsed.results.length === 0) {
          break;
        }

        this.collectRows(parsed.results, results, debugTrace, limit);
        // Break BEFORE asking for another page: a spent request is the thing this design exists to
        // avoid, so filling the budget on page one must cost one request, not two.
        if (results.length >= limit) {
          break;
        }
      } catch (error: unknown) {
        if (this.mustPropagate(error, page, options?.signal)) {
          throw error;
        }
        break;
      }
    }

    return {
      results,
      parseStats: { itemsObserved, kept: results.length, dropped },
      debugTrace,
      ...firstPage,
    };
  }

  /**
   * Whether a page failure ends the whole search or only the pagination.
   *
   * Page one failing IS the search failing: nothing came back, so returning an empty success tells
   * the caller this indexer answered a genuine zero — and the query ladder believes it, advances,
   * and asks a dead indexer again on every relaxed rung (#2375). A later page is a different story,
   * since the indexer demonstrably answered, so the pages already collected stand.
   *
   * Cancellation is not a page failure at all. Without the abort arm the later-page break degrades
   * an abort into a partial success, which the caller reads as a legitimate answer.
   */
  private mustPropagate(error: unknown, page: number, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (isProxyRelatedError(error)) return true;
    return page === 1;
  }

  /**
   * Trades the search-time sentinel for a real magnet, one detail fetch per grab. Anything else —
   * a magnet stored before this adapter went lazy, a v1 API payload — passes through untouched.
   */
  async resolveDownloadUrl(ctx: ResolveDownloadContext): Promise<ResolveDownloadResult> {
    const detailsUrl = parseAbbDetailsUrl(ctx.downloadUrl);
    if (detailsUrl === undefined) {
      return { downloadUrl: ctx.downloadUrl };
    }

    let detail: { infoHash?: string; title?: string };
    try {
      const fetched = await this.fetchPage(detailsUrl);
      detail = this.parseDetailPage(fetched.body);
    } catch (error: unknown) {
      // Wrapped even for a proxy failure, unlike `search()`: there is no degrade arm here, so the
      // discrimination buys nothing while the `IndexerError` type is what earns the `warn` line in
      // `resolveAdapterDownloadUrl`. `isProxyRelatedError(err.cause)` still answers true.
      throw new IndexerError(
        this.name,
        `ABB detail fetch failed for ${detailsUrl}: ${getErrorMessage(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    // Degrading to a success here would send the sentinel string itself to the download client.
    if (!detail.infoHash) {
      throw new IndexerError(this.name, `ABB detail page carried no info hash: ${detailsUrl}`);
    }
    return { downloadUrl: buildMagnetUri(detail.infoHash, detail.title) };
  }

  /**
   * Admits rows up to the remaining budget. Rows past it are not admitted and produce no trace
   * entry — they were never candidates, so recording them as kept or dropped would both lie.
   */
  private collectRows(
    pageResults: SearchResult[],
    results: SearchResult[],
    debugTrace: IndexerParseTrace[],
    limit: number,
  ): void {
    for (const result of pageResults) {
      if (results.length >= limit) return;
      results.push(result);
      const keptRawTitleBytes = rawTitleBytesHex(result.title);
      debugTrace.push({
        source: 'row',
        reason: 'kept',
        rawTitle: result.title,
        ...(keptRawTitleBytes !== undefined && { rawTitleBytes: keptRawTitleBytes }),
        ...(result.guid !== undefined && { guid: result.guid }),
      });
    }
  }

  private async fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult> {
    // FlareSolverr takes precedence over the standard proxy.
    if (this.flareSolverrUrl) {
      return this.fetchViaSolver(url, this.flareSolverrUrl, signal);
    }

    // Nothing intervenes between here and the wire on the direct and standard-proxy paths, so the
    // pacing wait is adjacent to the request it spaces.
    await abbThrottle.acquire(url, signal);
    return fetchWithProxyAgent(url, {
      headers: REQUEST_HEADERS,
      ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
      ...(signal !== undefined && { signal }),
    });
  }

  /**
   * The solver path has a queue of its own between us and the wire, so the pacing wait moves inside
   * the slot via `onBeforeDispatch` and the mutex keeps ABB from holding more than one slot while
   * it waits. Acquiring the interval here as well would double-charge every request.
   */
  private async fetchViaSolver(url: string, solverUrl: string, signal?: AbortSignal): Promise<FetchResult> {
    const releaseMutex = await acquireAbbSolverMutex(url, signal);
    try {
      return await fetchWithProxy({
        url,
        headers: REQUEST_HEADERS,
        proxyUrl: solverUrl,
        ...(signal !== undefined && { signal }),
        onBeforeDispatch: () => abbThrottle.acquire(url, signal),
      });
    } finally {
      releaseMutex();
    }
  }

  /**
   * Size, seeders and leechers are deliberately absent from every row: ABB's search markup carries
   * none of them, and the repo's own row fixture is the evidence. Faking a seeder count the way
   * Jackett does would be worse than absence — `search-pipeline.ts` treats unknown as "keep", so an
   * absent count survives every `minSeeders`, while a faked `1` is dropped at `minSeeders >= 2`.
   */
  private parseSearchPage(html: string): { results: SearchResult[]; observed: number; droppedEmptyTitle: number; droppedOther: number; debugTrace: IndexerParseTrace[] } {
    const $ = cheerio.load(html);
    // Ahead of row selection, and in place: an obfuscated post is the same node afterwards, still in
    // the same selector family, so neither `observed` nor the preference chain below can shift.
    inlineReAbPosts($);
    const results: SearchResult[] = [];
    const debugTrace: IndexerParseTrace[] = [];
    let droppedEmptyTitle = 0;
    let droppedOther = 0;

    // ABB markup varies; try selectors in preference order.
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
        // A surviving `re-ab` class means the decode pass refused the payload — the marker that
        // separates "this blob would not decode" from "this row simply has no title". One branch,
        // so the two counters cannot both claim the same row.
        if ($el.hasClass('re-ab')) {
          droppedOther++;
          debugTrace.push({ source: 'row', reason: 'dropped:re-ab-undecodable' });
        } else {
          droppedEmptyTitle++;
          debugTrace.push({ source: 'row', reason: 'dropped:empty-title' });
        }
        return;
      }

      if (!detailsUrl.startsWith('http')) {
        detailsUrl = `${this.baseUrl}${detailsUrl.startsWith('/') ? '' : '/'}${detailsUrl}`;
      }

      const coverUrl = $el.find('img').first().attr('src') ||
                       $el.find('img').first().attr('data-src');

      // Row metadata comes from the row's own annotated elements or not at all: its post text is
      // free prose over an uploader byline.
      const fields = readAbbMetadata($, $el);

      results.push({
        title,
        ...fields,
        protocol: 'torrent',
        // The details URL is ABB's only search-time identity now that the hash is not read until
        // grab time — it is what the blacklist and the previously-grabbed badge match on.
        guid: detailsUrl,
        downloadUrl: abbDetailsSentinel(detailsUrl),
        detailsUrl,
        ...(coverUrl !== undefined && { coverUrl }),
        indexer: this.name,
      });
    });

    return { results, observed: posts.length, droppedEmptyTitle, droppedOther, debugTrace };
  }

  /** The detail page's grab identity: the info hash, and the title the magnet's `dn` carries. */
  private parseDetailPage(html: string): { infoHash?: string; title?: string } {
    const $ = cheerio.load(html);

    const infoHashPatterns = [
      /Info\s*Hash[:\s]*([a-f0-9]{40})/i,
      /infohash[:\s]*([a-f0-9]{40})/i,
      /hash[:\s]*([a-f0-9]{40})/i,
      /([a-f0-9]{40})/i, // Last resort: any 40-char hex string
    ];

    // First search elements that commonly contain the hash; the whole page is the fallback.
    const hashContainers = [
      'td:contains("Info Hash")',
      '.torrent-detail',
      '.info-hash',
      '#info-hash',
      'pre',
      'code',
      'body',
    ];

    let infoHash: string | undefined;
    for (const container of hashContainers) {
      const text = $(container).text();
      for (const pattern of infoHashPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
          infoHash = match[1].toLowerCase();
          break;
        }
      }
      if (infoHash !== undefined) break;
    }

    const title = $('h1, .postTitle h2, article h2').first().text().trim();

    return {
      ...(infoHash !== undefined && { infoHash }),
      ...(title ? { title } : {}),
    };
  }

  async test(): Promise<{ success: boolean; message?: string; ip?: string }> {
    if (this.flareSolverrUrl) {
      return this.testViaFlareSolverr(this.flareSolverrUrl);
    }
    if (this.proxyUrl) {
      return this.testViaStandardProxy();
    }
    return this.testDirect();
  }

  private async testDirect(): Promise<{ success: boolean; message?: string }> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      // Before the timer is armed, so a request that waited out the floor still gets its full budget.
      await abbThrottle.acquire(this.baseUrl);
      timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);

      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        headers: REQUEST_HEADERS,
        signal: controller.signal,
      });

      if (response.ok || response.status === 405) {
        // A 405 Method Not Allowed is acceptable for ABB HEAD requests.
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
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async testViaFlareSolverr(solverUrl: string): Promise<{ success: boolean; message?: string }> {
    try {
      // Through the same mutex-and-hook path as search, or a connection test would be the one
      // solver-bound ABB request that paces before the slot rather than inside it.
      await this.fetchViaSolver(this.baseUrl, solverUrl);
      return { success: true, message: `Connected to ${this.config.hostname} via FlareSolverr` };
    } catch (error: unknown) {
      return {
        success: false,
        message: await describeSolverFailure(error, {
          targetProbeUrl: this.baseUrl,
          targetHost: this.config.hostname,
          solverUrl,
          ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
        }),
      };
    }
  }

  private async testViaStandardProxy(): Promise<{ success: boolean; message?: string; ip?: string }> {
    try {
      await abbThrottle.acquire(this.baseUrl);
      await fetchWithProxyAgent(this.baseUrl, {
        ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
        headers: REQUEST_HEADERS,
      });

      // Not paced: this asks the proxy's exit-IP service, not ABB.
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
