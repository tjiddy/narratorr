// Cache negative outcomes across call sites to avoid repeated getnzb downloads.
// Never cache NZB XML; it may contain archive passwords.
export type EnrichmentOutcome = 'resolved' | 'unresolved' | 'fetch-failed';

export interface EnrichmentCacheValue {
  outcome: EnrichmentOutcome;
  /** A stored undefined language is still a cache hit. */
  language: string | undefined;
  nzbName: string | undefined;
}

interface EnrichmentCacheEntry extends EnrichmentCacheValue {
  expiresAt: number;
}

export const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
// Retry failed fetches sooner without hammering a persistently broken endpoint.
export const FAILURE_TTL_MS = 60 * 60 * 1000;
export const MAX_ENTRIES = 5000;

export class EnrichmentCache {
  private readonly map = new Map<string, EnrichmentCacheEntry>();

  // Test entry presence, not language truthiness: unresolved results are cached.
  get(key: string): EnrichmentCacheValue | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return { outcome: entry.outcome, language: entry.language, nzbName: entry.nzbName };
  }

  set(key: string, value: EnrichmentCacheValue): void {
    const ttl = value.outcome === 'fetch-failed' ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    // Map.set preserves insertion order; delete first so refreshed entries become newest.
    this.map.delete(key);
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { ...value, expiresAt: Date.now() + ttl });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// Process-local only; tests clear it between cases.
export const enrichmentCache = new EnrichmentCache();
