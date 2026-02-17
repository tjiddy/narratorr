import type { FastifyBaseLogger } from 'fastify';
import {
  HardcoverProvider,
  AudnexusProvider,
  GoogleBooksProvider,
  AudibleProvider,
  RateLimitError,
  type MetadataProvider,
  type MetadataSearchResults,
  type BookMetadata,
  type AuthorMetadata,
  type SeriesMetadata,
} from '@narratorr/core';

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
  private providers: MetadataProvider[] = [];
  private audnexus: AudnexusProvider;
  private throttle = new RequestThrottle();
  private rateLimitUntil: Map<string, number> = new Map();

  constructor(private log: FastifyBaseLogger, config?: MetadataServiceConfig) {
    // Audible is always available (no API key required)
    const region = config?.audibleRegion ?? process.env.AUDIBLE_REGION ?? 'us';
    this.providers.push(new AudibleProvider({ region }));
    this.log.info({ region }, 'Metadata provider loaded: Audible');

    const apiKey = process.env.HARDCOVER_API_KEY;
    if (apiKey) {
      this.providers.push(new HardcoverProvider({ apiKey }));
      this.log.info('Metadata provider loaded: Hardcover');
    }

    const googleKey = process.env.GOOGLE_BOOKS_API_KEY;
    if (googleKey) {
      this.providers.push(new GoogleBooksProvider({ apiKey: googleKey }));
      this.log.info('Metadata provider loaded: Google Books');
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
    const books = await this.withThrottledSearch(provider, 'searchBooks', (p) => p.searchBooks(query), warnings);
    const authors = await this.withThrottledSearch(provider, 'searchAuthors', (p) => p.searchAuthors(query), warnings);
    const series = await this.withThrottledSearch(provider, 'searchSeries', (p) => p.searchSeries(query), warnings);

    this.log.debug(
      { books: books.length, authors: authors.length, series: series.length },
      'Metadata search results'
    );
    return warnings.length > 0 ? { books, authors, series, warnings } : { books, authors, series };
  }

  private async withThrottledSearch<T>(
    provider: MetadataProvider,
    method: string,
    fn: (provider: MetadataProvider) => Promise<T[]>,
    warnings: string[],
  ): Promise<T[]> {
    if (this.isRateLimited(provider.name)) return [];

    try {
      await this.throttle.acquire();
      return await fn(provider);
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        const remaining = Math.ceil(error.retryAfterMs / 1000);
        warnings.push(`${error.provider} rate limit reached, results may be incomplete. Try again in ${remaining}s.`);
        return [];
      }
      this.log.warn(error, `Metadata ${method} failed`);
      return [];
    }
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    return this.withThrottle('searchAuthors', (provider) => provider.searchAuthors(query), []);
  }

  async searchBooks(query: string): Promise<BookMetadata[]> {
    return this.withThrottle('searchBooks', (provider) => provider.searchBooks(query), []);
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    return this.withThrottle('getAuthor', (provider) => provider.getAuthor(id), null);
  }

  async getAuthorBooks(id: string): Promise<BookMetadata[]> {
    return this.withThrottle('getAuthorBooks', (provider) => provider.getAuthorBooks(id), []);
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    return this.withThrottle('getBook', (provider) => provider.getBook(id), null);
  }

  async getSeries(id: string): Promise<SeriesMetadata | null> {
    return this.withThrottle('getSeries', (provider) => provider.getSeries(id), null);
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
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        throw error; // Re-throw so enrichment job can handle it
      }
      this.log.warn({ error, asin }, 'Audnexus enrichment lookup failed');
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

  private async withThrottle<T>(
    method: string,
    fn: (provider: MetadataProvider) => Promise<T>,
    fallback: T,
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
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.setRateLimited(error.provider, error.retryAfterMs);
        return fallback;
      }
      this.log.warn(error, `Metadata ${method} failed`);
      return fallback;
    }
  }
}
