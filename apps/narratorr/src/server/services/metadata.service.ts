import {
  AudnexusProvider,
  type MetadataProvider,
  type MetadataSearchResults,
  type BookMetadata,
  type AuthorMetadata,
  type SeriesMetadata,
} from '@narratorr/core';

export class MetadataService {
  private providers: MetadataProvider[] = [];

  constructor() {
    this.providers.push(new AudnexusProvider());
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const provider = this.providers[0];
    try {
      return await provider.search(query);
    } catch {
      return { books: [], authors: [], series: [] };
    }
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    const provider = this.providers[0];
    try {
      return await provider.searchAuthors(query);
    } catch {
      return [];
    }
  }

  async searchBooks(query: string): Promise<BookMetadata[]> {
    const provider = this.providers[0];
    try {
      return await provider.searchBooks(query);
    } catch {
      return [];
    }
  }

  async getAuthor(asin: string): Promise<AuthorMetadata | null> {
    const provider = this.providers[0];
    try {
      return await provider.getAuthor(asin);
    } catch {
      return null;
    }
  }

  async getAuthorBooks(asin: string): Promise<BookMetadata[]> {
    const provider = this.providers[0];
    try {
      return await provider.getAuthorBooks(asin);
    } catch {
      return [];
    }
  }

  async getBook(asin: string): Promise<BookMetadata | null> {
    const provider = this.providers[0];
    try {
      return await provider.getBook(asin);
    } catch {
      return null;
    }
  }

  async getSeries(asin: string): Promise<SeriesMetadata | null> {
    const provider = this.providers[0];
    try {
      return await provider.getSeries(asin);
    } catch {
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
