import type { ImportListProvider, ImportListItem } from './types.js';

export interface AbsConfig {
  serverUrl: string;
  apiKey: string;
  libraryId: string;
}

export class AbsProvider implements ImportListProvider {
  readonly type = 'abs';
  readonly name = 'Audiobookshelf';

  private serverUrl: string;
  private apiKey: string;
  private libraryId: string;

  constructor(config: AbsConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.libraryId = config.libraryId;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const url = `${this.serverUrl}/api/libraries/${this.libraryId}/items`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`ABS API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as { results?: Array<{ media?: { metadata?: { title?: string; authorName?: string; asin?: string; isbn?: string } } }> };
    const results = data.results ?? [];

    const items: ImportListItem[] = [];
    for (const item of results) {
      const meta = item.media?.metadata;
      if (!meta?.title) continue;
      items.push({
        title: meta.title,
        author: meta.authorName || undefined,
        asin: meta.asin || undefined,
        isbn: meta.isbn || undefined,
      });
    }
    return items;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const url = `${this.serverUrl}/api/libraries`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        return { success: false, message: `API returned ${res.status}: ${res.statusText}` };
      }

      const data = await res.json() as { libraries?: Array<{ id: string; name: string }> };
      const libraries = data.libraries ?? [];
      const found = libraries.some((lib) => lib.id === this.libraryId);

      if (!found) {
        return { success: false, message: `Library ID "${this.libraryId}" not found. Available: ${libraries.map((l) => l.name).join(', ')}` };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
}
