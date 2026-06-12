/**
 * TTL cache for Usenet language-enrichment results, keyed per release.
 *
 * Why this exists (#1315): `enrichUsenetLanguages` fetched the full NZB body
 * from the indexer on EVERY search for any release lacking a language signal.
 * With five call sites (RSS interval, scheduled/interactive search, retry
 * search, post-process) hitting the same recent releases repeatedly, indexers
 * counted each getnzb hit as a download and flagged us as a misconfigured bot.
 *
 * This cache records the enrichment OUTCOME per release so a release seen by
 * ANY call site is never re-fetched within its TTL. Critically it caches
 * negative outcomes too (`unresolved` = fetched, no language; `fetch-failed` =
 * fetch errored) — those are exactly the releases that would otherwise re-fetch
 * forever.
 *
 * It never stores the NZB XML body — only `language` / `nzbName` / `outcome`
 * (the XML can carry archive passwords; see the logging rules in CLAUDE.md).
 */

/**
 * Terminal outcome of a Phase-2 enrichment attempt for one release.
 *
 * - `resolved`     — successful fetch, a signal (newsgroup / nzbName / title) set a language.
 * - `unresolved`   — successful fetch, no signal matched (`language` is undefined).
 * - `fetch-failed` — non-OK status or thrown error (after the title fallback ran).
 */
export type EnrichmentOutcome = 'resolved' | 'unresolved' | 'fetch-failed';

export interface EnrichmentCacheValue {
  outcome: EnrichmentOutcome;
  /** Detected language, or `undefined` when none — a stored `undefined` is a HIT, not a miss. */
  language: string | undefined;
  /** NZB name parsed from a successful fetch; absent on `fetch-failed`. */
  nzbName: string | undefined;
}

interface EnrichmentCacheEntry extends EnrichmentCacheValue {
  expiresAt: number;
}

/** Any completed fetch (resolved or unresolved) is trusted for ~24h. */
export const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A failed fetch is retried after ~1h — short enough that a transient indexer
 * error self-heals (picking up real groups + nzbName on the retry), long enough
 * that a persistently-failing getnzb URL is not hammered in between.
 */
export const FAILURE_TTL_MS = 60 * 60 * 1000;
/** Hard cap on retained entries; oldest-inserted evicted first when exceeded. */
export const MAX_ENTRIES = 5000;

export class EnrichmentCache {
  private readonly map = new Map<string, EnrichmentCacheEntry>();

  /**
   * Return the live cached value for `key`, or `undefined` when absent/expired.
   * An entry whose `language` is `undefined` is still a HIT — the caller must
   * distinguish "key absent" (do fetch) from "cached unresolved" (skip fetch)
   * by the presence of the returned value, never by language truthiness.
   */
  get(key: string): EnrichmentCacheValue | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return { outcome: entry.outcome, language: entry.language, nzbName: entry.nzbName };
  }

  /** Store an outcome under `key`, applying the per-outcome TTL and size cap. */
  set(key: string, value: EnrichmentCacheValue): void {
    const ttl = value.outcome === 'fetch-failed' ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    // Delete-before-set so overwriting an existing key re-appends it at the
    // insertion-order tail. `Map.set` on an existing key PRESERVES the original
    // position (#1328) — without the delete, a fetch-failed entry refreshed to
    // resolved 23h later keeps its day-old slot and becomes the first eviction
    // candidate at cap, inverted from intent. With the delete an overwrite never
    // reuses a stale slot, so the size check alone governs eviction — the old
    // `!has(key)` guard is no longer needed.
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

/**
 * Process-wide singleton shared by all enrichment call sites. Restart loses it
 * (acceptable per #1315 — surviving a restart is nice-to-have, not required).
 * Tests must call `enrichmentCache.clear()` in `beforeEach` for isolation.
 */
export const enrichmentCache = new EnrichmentCache();
