import type { FastifyBaseLogger } from 'fastify';
import {
  HardcoverProvider,
  AudnexusProvider,
  GoogleBooksProvider,
  type MetadataProvider,
  type MetadataSearchResults,
  type BookMetadata,
  type AuthorMetadata,
  type SeriesMetadata,
} from '@narratorr/core';

export class MetadataService {
  private providers: MetadataProvider[] = [];
  private audnexus: AudnexusProvider;

  constructor(private log: FastifyBaseLogger) {
    const apiKey = process.env.HARDCOVER_API_KEY;
    if (apiKey) {
      this.providers.push(new HardcoverProvider({ apiKey }));
      this.log.info('Metadata provider loaded: Hardcover');
    } else {
      this.log.warn('No HARDCOVER_API_KEY set — metadata lookups disabled');
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
    try {
      this.log.debug({ query, provider: provider.name }, 'Metadata search requested');
      const results = await provider.search(query);
      this.log.debug(
        { books: results.books.length, authors: results.authors.length, series: results.series.length },
        'Metadata search results'
      );
      return results;
    } catch (error) {
      this.log.warn(error, 'Metadata search failed');
      return { books: [], authors: [], series: [] };
    }
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    const provider = this.providers[0];
    if (!provider) return [];
    try {
      return await provider.searchAuthors(query);
    } catch (error) {
      this.log.warn(error, 'Metadata searchAuthors failed');
      return [];
    }
  }

  async searchBooks(query: string): Promise<BookMetadata[]> {
    const provider = this.providers[0];
    if (!provider) return [];
    try {
      return await provider.searchBooks(query);
    } catch (error) {
      this.log.warn(error, 'Metadata searchBooks failed');
      return [];
    }
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getAuthor(id);
    } catch (error) {
      this.log.warn(error, 'Metadata getAuthor failed');
      return null;
    }
  }

  async getAuthorBooks(id: string): Promise<BookMetadata[]> {
    const provider = this.providers[0];
    if (!provider) return [];
    try {
      return await provider.getAuthorBooks(id);
    } catch (error) {
      this.log.warn(error, 'Metadata getAuthorBooks failed');
      return [];
    }
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getBook(id);
    } catch (error) {
      this.log.warn(error, 'Metadata getBook failed');
      return null;
    }
  }

  async getSeries(id: string): Promise<SeriesMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getSeries(id);
    } catch (error) {
      this.log.warn(error, 'Metadata getSeries failed');
      return null;
    }
  }

  async enrichBook(asin: string): Promise<BookMetadata | null> {
    try {
      this.log.debug({ asin }, 'Audnexus enrichment lookup');
      const result = await this.audnexus.getBook(asin);
      if (result) {
        this.log.debug({ asin, hasNarrators: !!result.narrators?.length, hasDuration: !!result.duration }, 'Audnexus enrichment data found');
      } else {
        this.log.debug({ asin }, 'Audnexus returned no data for ASIN');
      }
      return result;
    } catch (error) {
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
}
