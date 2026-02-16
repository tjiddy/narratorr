import type { ProwlarrIndexer, ProwlarrProxyIndexer } from './types.js';

export class ProwlarrClient {
  constructor(
    private url: string,
    private apiKey: string,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  async healthCheck(): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.url}/api/v1/health`, {
        headers: { 'X-Api-Key': this.apiKey },
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, message: `HTTP ${res.status}: ${text}` };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  async getIndexers(): Promise<ProwlarrIndexer[]> {
    const res = await fetch(`${this.url}/api/v1/indexer`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`Prowlarr API error: HTTP ${res.status}`);
    }
    return res.json() as Promise<ProwlarrIndexer[]>;
  }

  buildProxyIndexers(indexers: ProwlarrIndexer[]): ProwlarrProxyIndexer[] {
    return indexers
      .filter((idx) => idx.enable)
      .map((idx) => ({
        prowlarrId: idx.id,
        name: idx.name,
        type: idx.protocol === 'torrent' ? 'torznab' as const : 'newznab' as const,
        apiUrl: `${this.url}/${idx.id}/`,
        apiKey: this.apiKey,
      }));
  }

  filterByCategories(
    indexers: ProwlarrIndexer[],
    categories: number[],
  ): ProwlarrIndexer[] {
    if (categories.length === 0) return indexers;

    return indexers.filter((idx) =>
      (idx.capabilities?.categories ?? []).some((cat) =>
        categories.includes(cat.id) ||
        (cat.subCategories ?? []).some((sub) => categories.includes(sub.id))
      )
    );
  }
}
