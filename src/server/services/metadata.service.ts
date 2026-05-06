import type { FastifyBaseLogger } from 'fastify';
import {
  AudnexusProvider,
  METADATA_SEARCH_PROVIDER_FACTORIES,
  RateLimitError,
  TransientError,
  type MetadataSearchProvider,
  type MetadataEnrichmentProvider,
  type MetadataSearchResults,
  type BookMetadata,
  type AuthorMetadata,
  type SeriesMetadata,
  type SearchBooksOptions,
  type SearchBooksResult,
} from '../../core/index.js';
import { filterByLanguage } from '../../core/utils/index.js';
import { parseWordList, matchesRejectWord } from '../../shared/parse-word-list.js';
import type { SettingsService } from './settings.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


const DEFAULT_THROTTLE_MS = 200;

class RequestThrottle {
  private lastRequest = 0;

  constructor(private minIntervalMs: number = DEFAULT_THROTTLE_MS) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequest = Date.now();
  }
}

export interface MetadataServiceConfig {
  audibleRegion?: string;
}

export class MetadataService {
  private providers: MetadataSearchProvider[] = [];
  private audnexus: MetadataEnrichmentProvider;
  private throttle = new RequestThrottle();
  private rateLimitUntil: Map<string, number> = new Map();

  constructor(private log: FastifyBaseLogger, config?: MetadataServiceConfig, private settingsService?: SettingsService) {
    const region = config?.audibleRegion ?? process.env.AUDIBLE_REGION ?? 'us';

    for (const [type, factory] of Object.entries(METADATA_SEARCH_PROVIDER_FACTORIES)) {
      const provider = factory({ region });
      this.providers.push(provider);
      this.log.info({ type, name: provider.name }, 'Metadata search provider loaded');
    }

    this.audnexus = new AudnexusProvider();
    this.log.info('Audnexus enrichment provider loaded');
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const provider = this.providers[0];
    if (!provider) {
      this.log.debug('No metadata provider configured, skipping search');
      return { books: [], authors: [], series: [] };
    }

    const warnings: string[] = [];

    if (this.isRateLimited(provider.name)) {
      const remaining = this.getRateLimitRemaining(provider.name);
      warnings.push(`${provider.name} rate limit reached, results may be incomplete. Try again in ${remaining}s.`);
      this.log.warn({ provider: provider.name, remainingSeconds: remaining }, 'Search skipped — provider rate limited');
      return { books: [], authors: [], series: [], warnings };
    }

    this.log.debug({ query, provider: provider.name }, 'Metadata search requested');

    // Call each sub-search through throttle individually to prevent bursting
    const books = await this.withThrottledSearch(provider, 'searchBooks', async (p) => {
      const result = await p.searchBooks(query);
      this.logParseDrop(result, p.name);
      return result.books;
    }, warnings);
    const authors = await this.withThrottledSearch(provider, 'searchAuthors', (p) => p.searchAuthors(query), warnings);
    const series = await this.withThrottledSearch(provider, 'searchSeries', (p) => p.searchSeries(query), warnings);

    const filteredBooks = await this.applyBookFilters(books);

    this.log.debug(
      { books: filteredBooks.length, authors: authors.length, series: series.length },
      'Metadata search results'
    );
    return warnings.length > 0 ? { books: filteredBooks, authors, series, warnings } : { books: filteredBooks, authors, series };
  }

  private async withThrottledSearch<T>(
    provider: MetadataSearchProvider,
    method: string,
    fn: (provider: MetadataSearchProvider) => Promise<T[]>,
    warnings: string[],
  ): Promise<T[]> {
    if (this.isRateLimited(provider.name)) return [];

    try {
      await this.throttle.acquire();
      return await fn(provider);
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        const remaining = Math.ceil(error.retryAfterMs / 1000);
        warnings.push(`${error.provider} rate limit reached, results may be incomplete. Try again in ${remaining}s.`);
        return [];
      }
      if (error instanceof TransientError) {
        warnings.push(`${provider.name} ${method} transient failure: ${error.message}`);
        this.log.warn({ error: serializeError(error) }, `Metadata ${method} failed`);
        return [];
      }
      const msg = getErrorMessage(error);
      warnings.push(`${provider.name} ${method} failed: ${msg}`);
      this.log.warn({ error: serializeError(error) }, `Metadata ${method} failed`);
      return [];
    }
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    return this.withThrottle('searchAuthors', (provider) => provider.searchAuthors(query), []);
  }

  async searchBooks(query: string, options?: SearchBooksOptions): Promise<BookMetadata[]> {
    const result = await this.withThrottle<SearchBooksResult>('searchBooks', (provider) => provider.searchBooks(query, options), { books: [] }, { query });
    const books = result.books;
    this.logParseDrop(result, this.providers[0]?.name);
    const filtered = await this.applyBookFilters(books);
    this.log.debug(
      { query, provider: this.providers[0]?.name, resultCount: filtered.length, filteredOut: books.length - filtered.length },
      'searchBooks completed',
    );
    return filtered;
  }

  async searchBooksForDiscovery(
    query: string,
    options?: SearchBooksOptions,
  ): Promise<{ books: BookMetadata[]; warnings: string[] }> {
    const provider = this.providers[0];
    if (!provider) {
      return { books: [], warnings: [] };
    }

    const warnings: string[] = [];

    if (this.isRateLimited(provider.name)) {
      const remaining = this.getRateLimitRemaining(provider.name);
      warnings.push(`${provider.name} rate limit reached, results may be incomplete. Try again in ${remaining}s.`);
      return { books: [], warnings };
    }

    const books = await this.withThrottledSearch(
      provider,
      'searchBooksForDiscovery',
      async (p) => {
        const result = await p.searchBooks(query, options);
        this.logParseDrop(result, p.name);
        return result.books;
      },
      warnings,
    );

    const filtered = await this.applyBookFilters(books);
    return { books: filtered, warnings };
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    if (this.isRateLimited('Audnexus')) {
      this.log.warn({ id }, 'Author lookup skipped — Audnexus rate limited');
      return null;
    }

    try {
      await this.throttle.acquire();
      return await this.audnexus.getAuthor(id);
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        return null;
      }
      this.log.warn({ error: serializeError(error) }, 'Audnexus getAuthor failed');
      return null;
    }
  }

  async getAuthorBooks(id: string): Promise<BookMetadata[]> {
    // Resolve author name via Audnexus, then search Audible by name
    const author = await this.getAuthor(id);
    if (!author?.name) {
      this.log.debug({ id }, 'Cannot fetch author books — author not found');
      return [];
    }

    const result = await this.withThrottle<SearchBooksResult>(
      'searchBooks',
      (provider) => provider.searchBooks(author.name, { author: author.name, maxResults: 50 }),
      { books: [] },
    );

    return this.applyBookFilters(result.books);
  }

  // Single source of truth for the metadata filter chain.
  // Each helper reads its own settings slice and fails open independently —
  // see issue #1004 for the symmetric fail-open model.
  private async applyBookFilters(books: BookMetadata[]): Promise<BookMetadata[]> {
    if (books.length === 0) return books;
    const rejectFiltered = await this.filterRejectedBooks(books);
    const languageFiltered = await this.filterBooksByLanguage(rejectFiltered);
    return this.filterByMinDuration(languageFiltered);
  }

  private async filterBooksByLanguage(books: BookMetadata[]): Promise<BookMetadata[]> {
    if (!this.settingsService) return books;

    let languages: readonly string[];
    try {
      const metadata = await this.settingsService.get('metadata');
      languages = metadata.languages;
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Failed to read language settings for search filtering — returning unfiltered results');
      return books;
    }

    return filterByLanguage(books, languages).kept;
  }

  private async filterRejectedBooks(books: BookMetadata[]): Promise<BookMetadata[]> {
    if (!this.settingsService) return books;
    if (books.length === 0) return books;

    let rejectWords: string;
    try {
      const quality = await this.settingsService.get('quality');
      rejectWords = quality.rejectWords;
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Failed to read reject-words setting — returning unfiltered results');
      return books;
    }

    const rejectList = parseWordList(rejectWords);
    if (rejectList.length === 0) return books;

    return books.filter((book) => {
      const authorNames = (book.authors ?? []).map((a) => a.name).join(' ');
      const narrators = (book.narrators ?? []).join(' ');
      const surface = `${book.title} ${book.subtitle ?? ''} ${authorNames} ${narrators} ${book.formatType ?? ''}`.toLowerCase();
      return !rejectList.some((word) => matchesRejectWord(surface, word));
    });
  }

  private async filterByMinDuration(books: BookMetadata[]): Promise<BookMetadata[]> {
    if (!this.settingsService) return books;
    if (books.length === 0) return books;

    let minDurationMinutes: number;
    try {
      const metadata = await this.settingsService.get('metadata');
      minDurationMinutes = metadata.minDurationMinutes;
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Failed to read minDurationMinutes setting — returning unfiltered results');
      return books;
    }

    if (minDurationMinutes <= 0) return books;

    return books.filter((book) => book.duration == null || book.duration >= minDurationMinutes);
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    const result = await this.withThrottle('getBook', (provider) => provider.getBook(id), null, { query: id });
    this.log.debug({ id, provider: this.providers[0]?.name, found: result !== null }, 'getBook completed');
    return result;
  }

  async getSeries(_id: string): Promise<SeriesMetadata | null> {
    // Series detail lookup is not supported by any current provider
    return null;
  }

  async enrichBook(asin: string): Promise<BookMetadata | null> {
    if (this.isRateLimited('Audnexus')) {
      this.log.warn({ asin }, 'Enrichment skipped — Audnexus rate limited');
      return null;
    }

    try {
      await this.throttle.acquire();
      this.log.debug({ asin }, 'Audnexus enrichment lookup');
      const result = await this.audnexus.getBook(asin);
      if (result) {
        this.log.debug({ asin, hasNarrators: !!result.narrators?.length, hasDuration: !!result.duration }, 'Audnexus enrichment data found');
      } else {
        this.log.debug({ asin }, 'Audnexus returned no data for ASIN');
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        throw error; // Re-throw so enrichment job can handle it
      }
      this.log.warn({ error: serializeError(error), asin }, 'Audnexus enrichment lookup failed');
      return null;
    }
  }

  async testProviders(): Promise<{ name: string; type: string; success: boolean; message?: string }[]> {
    const results = [];
    for (const provider of this.providers) {
      const result = await provider.test();
      results.push({ name: provider.name, type: provider.type, ...result });
    }
    return results;
  }

  getProviders(): { name: string; type: string }[] {
    return this.providers.map((p) => ({ name: p.name, type: p.type }));
  }

  private isRateLimited(providerName: string): boolean {
    const until = this.rateLimitUntil.get(providerName);
    if (!until) return false;
    if (Date.now() >= until) {
      this.rateLimitUntil.delete(providerName);
      return false;
    }
    return true;
  }

  private getRateLimitRemaining(providerName: string): number {
    const until = this.rateLimitUntil.get(providerName);
    if (!until) return 0;
    return Math.ceil(Math.max(0, until - Date.now()) / 1000);
  }

  private setRateLimited(providerName: string, durationMs: number): void {
    this.rateLimitUntil.set(providerName, Date.now() + durationMs);
    this.log.warn({ provider: providerName, retryAfterMs: durationMs }, 'Provider rate limited');
  }

  private logParseDrop(result: SearchBooksResult, providerName: string | undefined): void {
    if (result.rawCount !== undefined && result.rawCount !== result.books.length) {
      this.log.debug(
        { rawCount: result.rawCount, parsedCount: result.books.length, provider: providerName },
        'Metadata search parse drop detected',
      );
    }
  }

  private async withThrottle<T>(
    method: string,
    fn: (provider: MetadataSearchProvider) => Promise<T>,
    fallback: T,
    context?: Record<string, unknown>,
  ): Promise<T> {
    const provider = this.providers[0];
    if (!provider) return fallback;

    if (this.isRateLimited(provider.name)) {
      this.log.warn({ provider: provider.name, method }, 'Request skipped — provider rate limited');
      return fallback;
    }

    try {
      await this.throttle.acquire();
      return await fn(provider);
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        return fallback;
      }
      this.log.warn({ ...context, error: serializeError(error) }, `Metadata ${method} failed`);
      return fallback;
    }
  }
}
