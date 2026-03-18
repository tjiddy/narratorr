/**
 * Generic adapter cache — Map<id, Adapter> with clear/delete lifecycle.
 * Used by IndexerService and DownloadClientService to avoid duplicate
 * Map boilerplate.
 */
export class AdapterCache<T> {
  private cache = new Map<number, T>();

  get(id: number): T | undefined {
    return this.cache.get(id);
  }

  set(id: number, adapter: T): void {
    this.cache.set(id, adapter);
  }

  delete(id: number): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }
}
