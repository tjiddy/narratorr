import type { FastifyBaseLogger } from 'fastify';
import {
  HardcoverProvider,
  type MetadataProvider,
  type MetadataSearchResults,
  type BookMetadata,
  type AuthorMetadata,
  type SeriesMetadata,
} from '@narratorr/core';

export class MetadataService {
  private providers: MetadataProvider[] = [];

  constructor(private log: FastifyBaseLogger) {
    const apiKey = process.env.HARDCOVER_API_KEY;
    if (apiKey) {
      this.providers.push(new HardcoverProvider({ apiKey }));
      this.log.info('Metadata provider loaded: Hardcover');
    } else {
      this.log.warn('No HARDCOVER_API_KEY set — metadata lookups disabled');
    }
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const provider = this.providers[0];
    if (!provider) return { books: [], authors: [], series: [] };
    try {
      return await provider.search(query);
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

  async getAuthor(asin: string): Promise<AuthorMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getAuthor(asin);
    } catch (error) {
      this.log.warn(error, 'Metadata getAuthor failed');
      return null;
    }
  }

  async getAuthorBooks(asin: string): Promise<BookMetadata[]> {
    const provider = this.providers[0];
    if (!provider) return [];
    try {
      return await provider.getAuthorBooks(asin);
    } catch (error) {
      this.log.warn(error, 'Metadata getAuthorBooks failed');
      return [];
    }
  }

  async getBook(asin: string): Promise<BookMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getBook(asin);
    } catch (error) {
      this.log.warn(error, 'Metadata getBook failed');
      return null;
    }
  }

  async getSeries(asin: string): Promise<SeriesMetadata | null> {
    const provider = this.providers[0];
    if (!provider) return null;
    try {
      return await provider.getSeries(asin);
    } catch (error) {
      this.log.warn(error, 'Metadata getSeries failed');
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
