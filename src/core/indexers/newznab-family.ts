/**
 * The shared implementation behind the two caps-family adapters (Torznab and Newznab).
 *
 * The protocols are the same wire protocol with different attribute vocabularies, so everything
 * except six behavioural axes is identical between them. Those six are the abstract surface below;
 * a subclass declares its profile values and its two hooks, and owns nothing else.
 */

import * as cheerio from 'cheerio';
import {
  rawTitleBytesHex,
  type IndexerAdapter,
  type IndexerParseTrace,
  type IndexerSearchResponse,
  type SearchOptions,
  type SearchResult,
} from './types.js';
import { parseOptionalNumber } from './parse-attr.js';
import { fetchWithProxy } from './fetch.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { describeSolverFailure, probeTargetFromApiUrl } from './solver-diagnosis.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { getErrorMessage } from '@shared/error-message.js';
import { normalizeBaseUrl } from '@shared/normalize-base-url.js';
import { getUserAgent } from '@shared/user-agent.js';

export interface NewznabFamilyConfig {
  apiUrl: string;
  apiKey: string;
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

/** Everything shared about a kept item; the protocol hook adds its own fields on top. */
export type KeptResultBase = Omit<SearchResult, 'protocol'>;

const AUDIOBOOK_CATEGORY = '3030';

const XML_ACCEPT = 'application/rss+xml, application/xml, text/xml';

export abstract class NewznabFamilyIndexer implements IndexerAdapter {
  /** Declared without a type annotation in each subclass, so the literal survives (#2391 AC3). */
  abstract readonly type: string;
  readonly name: string;

  private apiUrl: string;
  private apiKey: string;
  private flareSolverrUrl?: string;
  private proxyUrl?: string;

  /** The `attrs=` request parameter — each protocol asks for its own attribute vocabulary. */
  protected abstract readonly searchAttrs: string;
  /** Prefixes a non-RSS payload's `<error>` throw; the operator sees which adapter answered. */
  protected abstract readonly apiErrorPrefix: string;
  /** The `<*:attr>` element selector; torznab reads one namespace more than newznab does. */
  protected abstract readonly attrSelector: string;

  constructor(config: NewznabFamilyConfig, name?: string) {
    this.apiUrl = normalizeBaseUrl(config.apiUrl);
    this.apiKey = config.apiKey;
    const flareSolverrUrl = normalizeBaseUrl(config.flareSolverrUrl);
    if (flareSolverrUrl !== undefined) this.flareSolverrUrl = flareSolverrUrl;
    if (config.proxyUrl !== undefined) this.proxyUrl = config.proxyUrl;
    this.name = name || new URL(config.apiUrl).hostname;
  }

  /**
   * Resolve an item's download URL. `directUrl` is the shared enclosure-then-`<link>` derivation;
   * a torrent protocol can still synthesize one from an infohash, a usenet one cannot.
   *
   * Not named `resolveDownloadUrl`: `IndexerAdapter` already declares that as an optional PUBLIC
   * method with an unrelated signature (grab-time sentinel resolution), and a same-named protected
   * member fails TS2416 against it.
   */
  protected abstract resolveItemDownloadUrl(
    directUrl: string | undefined,
    title: string,
    attrs: Record<string, string>,
  ): string | undefined;

  /** Add the protocol and its protocol-only fields to the shared result. */
  protected abstract buildKeptResult(
    common: KeptResultBase,
    attrs: Record<string, string>,
  ): SearchResult;

  async search(query: string, options?: SearchOptions): Promise<IndexerSearchResponse> {
    const limit = options?.limit ?? 100;
    const params = new URLSearchParams({
      t: 'search',
      q: query,
      apikey: this.apiKey,
      cat: AUDIOBOOK_CATEGORY,
      limit: String(limit),
      attrs: this.searchAttrs,
    });

    if (options?.author) {
      params.set('author', options.author);
    }

    const url = `${this.apiUrl}/api?${params.toString()}`;

    // Let the service isolate and log per-indexer failures.
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

      // FlareSolverr does not expose the standard proxy's exit-IP path.
      if (this.proxyUrl && !this.flareSolverrUrl) {
        result.ip = await resolveProxyIp(this.proxyUrl);
      }

      return result;
    } catch (error: unknown) {
      if (this.flareSolverrUrl) {
        return {
          success: false,
          message: await describeSolverFailure(error, {
            ...probeTargetFromApiUrl(this.apiUrl),
            solverUrl: this.flareSolverrUrl,
            ...(this.proxyUrl !== undefined && { proxyUrl: this.proxyUrl }),
          }),
        };
      }
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async fetchXml(url: string, signal?: AbortSignal) {
    const headers = { Accept: XML_ACCEPT, 'User-Agent': getUserAgent() };

    // FlareSolverr takes precedence over the standard proxy.
    if (this.flareSolverrUrl) {
      return fetchWithProxy({
        url,
        headers,
        proxyUrl: this.flareSolverrUrl,
        signal,
      });
    }

    return fetchWithProxyAgent(url, {
      proxyUrl: this.proxyUrl,
      headers,
      signal,
    });
  }

  private parseSearchResults(xml: string, limit: number): { results: SearchResult[]; parseStats: IndexerSearchResponse['parseStats']; debugTrace: IndexerParseTrace[] } {
    const $ = cheerio.load(xml, { xmlMode: true });

    // Invalid/non-RSS payloads are boundary failures, not empty result sets.
    if ($('rss').length === 0 && $('channel').length === 0) {
      const apiError = $('error').attr('description') || $('error').attr('code');
      if (apiError) {
        throw new Error(`${this.apiErrorPrefix}: ${apiError}`);
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

      // Attrs are parsed before the URL is resolved because a torrent magnet fallback is built from
      // one of them. Parsing is pure, so the ordering is unobservable to a protocol that ignores it.
      const attrs = this.parseNewznabAttrs($item, $);

      const directUrl =
        $item.find('enclosure').attr('url') ||
        $item.find('link').first().text().trim() ||
        undefined;
      const downloadUrl = this.resolveItemDownloadUrl(directUrl, title, attrs);

      if (!downloadUrl) {
        dropped.noUrl++;
        const droppedRawBytes = rawTitleBytesHex(title);
        debugTrace.push({
          source: 'item',
          reason: 'dropped:no-url',
          rawTitle: title,
          ...(droppedRawBytes !== undefined && { rawTitleBytes: droppedRawBytes }),
          ...(guidText !== undefined && { guid: guidText }),
        });
        return; // continue
      }

      results.push(this.buildKeptResult(this.commonResult($item, title, downloadUrl, guidText, attrs), attrs));
      const keptRawBytes = rawTitleBytesHex(title);
      debugTrace.push({
        source: 'item',
        reason: 'kept',
        rawTitle: title,
        ...(keptRawBytes !== undefined && { rawTitleBytes: keptRawBytes }),
        ...(guidText !== undefined && { guid: guidText }),
      });
    });

    return {
      results,
      parseStats: { itemsObserved, kept: results.length, dropped },
      debugTrace,
    };
  }

  private commonResult(
    $item: ReturnType<cheerio.CheerioAPI>,
    title: string,
    downloadUrl: string,
    guidText: string | undefined,
    attrs: Record<string, string>,
  ): KeptResultBase {
    const detailsUrl =
      guidText ||
      $item.find('comments').text().trim() ||
      undefined;

    const size =
      attrs.size != null
        ? Number(attrs.size)
        : Number($item.find('enclosure').attr('length')) || undefined;

    const finalSize = size || undefined;
    const finalGrabs = parseOptionalNumber(attrs.grabs);
    const language = normalizeLanguage(attrs.language);

    return {
      title,
      downloadUrl,
      indexer: this.name,
      ...(detailsUrl !== undefined && { detailsUrl }),
      ...(guidText !== undefined && { guid: guidText }),
      ...(finalSize !== undefined && { size: finalSize }),
      ...(finalGrabs !== undefined && { grabs: finalGrabs }),
      ...(language !== undefined && { language }),
    };
  }

  private parseNewznabAttrs(
    $item: ReturnType<cheerio.CheerioAPI>,
    $: cheerio.CheerioAPI,
  ): Record<string, string> {
    const attrs: Record<string, string> = {};

    $item.find(this.attrSelector).each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value');
      if (name && value) {
        attrs[name] = value;
      }
    });

    return attrs;
  }
}
