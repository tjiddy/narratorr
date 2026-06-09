import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/indexers/types.js';
import { normalizeLanguage } from '../../core/utils/language-codes.js';
import { detectLanguageFromNewsgroup, detectLanguageFromText, parseNzbGroups, parseNzbName, parseNzbFileSubject } from '../../core/utils/detect-usenet-language.js';
import { createSsrfSafeDispatcher, fetchWithSsrfRedirect } from '../../core/utils/network-service.js';
import type { LanAllowlist } from '../../core/utils/download-url.js';
import { getUserAgent } from '../../shared/user-agent.js';
import { Semaphore } from './semaphore.js';
import { serializeError } from './serialize-error.js';
import { sanitizeLogUrl } from './sanitize-log-url.js';
import { enrichmentCache, type EnrichmentCacheValue } from './enrichment-cache.js';

const NZB_FETCH_CONCURRENCY = 5;
const NZB_FETCH_TIMEOUT_MS = 5000;

/**
 * Phase-2 fetch cap for auto-grab call sites (scheduled/interactive grab, retry
 * search, RSS). The interactive/post-process display path stays uncapped. #1315.
 */
export const AUTO_GRAB_PHASE2_CAP = 10;

type Phase2Source = 'newsgroup' | 'name' | 'title' | 'unresolved';

export interface EnrichUsenetOptions {
  /**
   * Cap on the number of Phase-2 NZB fetches per run. When set, after the cache
   * is consulted the remaining cache-miss candidates are ranked (matchScore,
   * then seeders, then grabs; all desc, missing lowest) and only the top N are
   * fetched — the rest keep their Phase-1 result and are NOT fetched. Omit for
   * today's uncapped behavior (used by the interactive/post-process path).
   */
  maxPhase2Fetches?: number;
}

/** Cache key for a release: prefer the stable `guid`, fall back to `downloadUrl`. */
function cacheKeyFor(result: SearchResult): string | undefined {
  return result.guid ?? result.downloadUrl;
}

/**
 * Compare two optional numbers descending; missing (`undefined`) ranks lowest.
 * Avoids Infinity arithmetic (which yields NaN for two missing values and
 * corrupts `Array.sort`).
 */
function cmpDesc(a: number | undefined, b: number | undefined): number {
  const av = a ?? -Infinity;
  const bv = b ?? -Infinity;
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
}

/** Phase-2 ranking tuple: matchScore, then seeders, then grabs — all descending. */
function comparePhase2(a: SearchResult, b: SearchResult): number {
  return cmpDesc(a.matchScore, b.matchScore)
    || cmpDesc(a.seeders, b.seeders)
    || cmpDesc(a.grabs, b.grabs);
}

/**
 * Apply a cached enrichment outcome to a result. Returns `true` when it set a
 * language (so the caller can bump the audit counter). Reapplies the cached
 * `nzbName` so the downstream multi-part filter still sees it on a hit; on a
 * `fetch-failed` entry `nzbName` is intentionally absent.
 */
function applyCacheHit(result: SearchResult, entry: EnrichmentCacheValue, logger: FastifyBaseLogger): boolean {
  let detected = false;
  if (entry.language && !result.language) {
    result.language = entry.language;
    detected = true;
  }
  if (entry.nzbName && !result.nzbName) {
    result.nzbName = entry.nzbName;
  }
  logger.debug(
    { title: result.title, signal: 'cache-hit', outcome: entry.outcome, language: entry.language ?? null },
    'Phase-2: served from enrichment cache',
  );
  return detected;
}

/**
 * Consult the cache for every fetch candidate. Cache hits are applied in-place
 * and dropped from the returned `misses` set; misses (no live entry) survive to
 * Phase-2 fetching. A stored `undefined` language is a HIT, never a miss.
 */
function consultCache(
  needsFetch: SearchResult[],
  logger: FastifyBaseLogger,
): { misses: SearchResult[]; hitsDetected: number } {
  const misses: SearchResult[] = [];
  let hitsDetected = 0;
  for (const result of needsFetch) {
    const key = cacheKeyFor(result);
    const entry = key ? enrichmentCache.get(key) : undefined;
    if (entry) {
      if (applyCacheHit(result, entry, logger)) hitsDetected++;
    } else {
      misses.push(result);
    }
  }
  return { misses, hitsDetected };
}

/**
 * Apply the per-call-site Phase-2 cap to the cache-miss candidate set. When the
 * cap is unset or not exceeded, returns the candidates unchanged. Otherwise
 * ranks by `comparePhase2`, keeps the top `cap`, and logs the skipped count.
 */
function selectCappedCandidates(
  candidates: SearchResult[],
  cap: number | undefined,
  logger: FastifyBaseLogger,
): SearchResult[] {
  if (cap === undefined || candidates.length <= cap) return candidates;
  const ranked = [...candidates].sort(comparePhase2);
  logger.debug(
    { candidates: candidates.length, cap, skipped: candidates.length - cap },
    'Phase-2 fetch cap applied — skipped lowest-ranked candidates',
  );
  return ranked.slice(0, cap);
}

/**
 * Defense-in-depth title fallback for fetch-failure branches (non-OK response or
 * thrown exception). Returns `true` when it sets `result.language` so the caller
 * can bump the `languagesDetected` audit counter. Guarded on `result.language`
 * so an earlier signal (Phase 1) is never overwritten. Signal name is distinct
 * from the Phase-2 successful-fetch `title-pattern` signal — grep-friendly.
 */
function tryTitleFallback(result: SearchResult, logger: FastifyBaseLogger): boolean {
  if (result.language) return false;
  const titleLang = normalizeLanguage(detectLanguageFromText(result.title));
  if (!titleLang) return false;
  result.language = titleLang;
  logger.debug(
    { title: result.title, signal: 'title-after-fetch-fail', matched: titleLang },
    'Language detected from title after NZB fetch failure',
  );
  return true;
}

/**
 * Walk the post-fetch signal cascade — newsgroups → nzbName → title — and set
 * `result.language` on the first hit. Each pass is guarded on `result.language`
 * (not a separate flag) so an earlier hit always wins. Emits per-signal debug
 * traces so a search can be replayed from log output.
 */
function detectPhase2Source(
  result: SearchResult,
  groups: string[],
  logger: FastifyBaseLogger,
): Phase2Source {
  for (const group of groups) {
    const lang = normalizeLanguage(detectLanguageFromNewsgroup(group));
    logger.debug({ title: result.title, signal: 'newsgroup-token', testedAgainst: group, matched: lang ?? null }, 'Detection attempt');
    if (lang) {
      result.language = lang;
      return 'newsgroup';
    }
  }

  const nameLang = normalizeLanguage(detectLanguageFromText(result.nzbName));
  logger.debug({ title: result.title, signal: 'nzb-name-pattern', testedAgainst: result.nzbName, matched: nameLang ?? null }, 'Detection attempt');
  if (nameLang) {
    result.language = nameLang;
    return 'name';
  }

  const titleLang = normalizeLanguage(detectLanguageFromText(result.title));
  logger.debug({ title: result.title, signal: 'title-pattern', testedAgainst: result.title, matched: titleLang ?? null }, 'Detection attempt');
  if (titleLang) {
    result.language = titleLang;
    return 'title';
  }

  return 'unresolved';
}

/**
 * Enrich Usenet search results with language detected from newsgroup metadata.
 *
 * Priority:
 * 1. Skip results that already have language, are torrents, or lack downloadUrl
 * 2. If result.newsgroup is populated, detect language from it (no fetch)
 * 3. If result.newsgroup is absent, fetch the NZB and parse <group> tags
 *
 * The optional `lanAllowlist` (#1149) lets the NZB-body fetch reach a configured
 * indexer's host:port even when its address is private/loopback. The fetch
 * still routes through the SSRF helpers and any redirect hop outside the
 * allowlist is refused. The leaf parameter is optional only so existing
 * test invocations stay valid; production wrappers (postProcessSearchResults,
 * searchAndGrabForBook, retrySearch, runRssJob) take `indexerService` as a
 * required dependency and forward the allowlist.
 *
 * Mutates results in-place. Non-blocking: fetch failures are logged and skipped.
 */
export async function enrichUsenetLanguages(
  results: SearchResult[],
  logger: FastifyBaseLogger,
  lanAllowlist?: LanAllowlist,
  options?: EnrichUsenetOptions,
): Promise<void> {
  const startMs = Date.now();
  const userAgent = getUserAgent();
  let nzbFetched = 0;
  let languagesDetected = 0;

  // Identify Usenet results that need language detection
  const usenetResults = results.filter(
    (r) => r.protocol === 'usenet' && !r.language,
  );

  // Phase 1: Detect language from existing newsgroup field; fall through to NZB fetch
  // when newsgroup is generic (no language token found) so nzbName is still populated.
  const needsFetch: SearchResult[] = [];
  for (const result of usenetResults) {
    logger.debug({
      title: result.title,
      hasLanguage: !!result.language,
      protocol: result.protocol,
      hasNewsgroup: !!result.newsgroup,
      hasDownloadUrl: !!result.downloadUrl,
    }, 'Enrichment phase-1 input');

    if (result.newsgroup) {
      const lang = normalizeLanguage(detectLanguageFromNewsgroup(result.newsgroup));
      if (lang) {
        result.language = lang;
        languagesDetected++;
        logger.debug({ title: result.title, newsgroup: result.newsgroup, detectedLanguage: lang }, 'Phase-1: language detected from existing newsgroup');
      } else if (result.downloadUrl) {
        // Generic newsgroup (e.g., alt.binaries.audiobooks) — fall through to NZB fetch
        // so nzbName is populated for reject/required word filtering and name-based language detection
        logger.debug({ title: result.title, newsgroup: result.newsgroup }, 'Phase-1: newsgroup generic, falling through to NZB fetch');
        needsFetch.push(result);
      } else {
        // No fetch possible — try title as a last resort before giving up.
        const titleLang = normalizeLanguage(detectLanguageFromText(result.title));
        if (titleLang) {
          result.language = titleLang;
          languagesDetected++;
          logger.debug({ title: result.title, signal: 'title', matched: titleLang }, 'Phase-1: language detected from title (no-fetch branch)');
        } else {
          logger.debug({ title: result.title, reason: 'no-download-url' }, 'Phase-1: skipped, cannot fetch');
        }
      }
    } else if (result.downloadUrl) {
      logger.debug({ title: result.title }, 'Phase-1: no newsgroup, falling through to NZB fetch');
      needsFetch.push(result);
    } else {
      // No newsgroup AND no downloadUrl — try title as a last resort.
      const titleLang = normalizeLanguage(detectLanguageFromText(result.title));
      if (titleLang) {
        result.language = titleLang;
        languagesDetected++;
        logger.debug({ title: result.title, signal: 'title', matched: titleLang }, 'Phase-1: language detected from title (no-fetch branch)');
      } else {
        logger.debug({ title: result.title, reason: 'no-download-url' }, 'Phase-1: skipped, cannot fetch');
      }
    }
  }

  // Cache consult: serve releases enriched by any prior run (this is the #1315
  // fix — a release seen by ANY call site is never re-fetched within its TTL).
  // Hits are applied in-place and dropped; misses proceed to the (capped) fetch.
  const { misses, hitsDetected } = consultCache(needsFetch, logger);
  languagesDetected += hitsDetected;

  // Per-call-site Phase-2 cap (ranked) applied to the cache-miss set, before
  // any semaphore permit is acquired so capped-out candidates don't consume slots.
  const toFetch = selectCappedCandidates(misses, options?.maxPhase2Fetches, logger);

  // Phase 2: Fetch NZBs in parallel with concurrency limit
  const semaphore = new Semaphore(NZB_FETCH_CONCURRENCY);

  async function fetchAndEnrich(result: SearchResult): Promise<void> {
    await semaphore.acquire();
    nzbFetched++;
    const cacheKey = cacheKeyFor(result)!;
    const dispatcher = createSsrfSafeDispatcher(lanAllowlist?.hostname);
    const safeUrl = sanitizeLogUrl(result.downloadUrl!);
    try {
      logger.debug({ title: result.title, url: safeUrl }, 'Phase-2: fetching NZB');
      const response = await fetchWithSsrfRedirect(result.downloadUrl!, {
        dispatcher,
        timeoutMs: NZB_FETCH_TIMEOUT_MS,
        headers: { 'User-Agent': userAgent },
        ...(lanAllowlist && { lanAllowlist: lanAllowlist.hostPort }),
      });
      logger.debug({
        title: result.title,
        status: response.status,
        contentLength: response.headers.get('content-length'),
      }, 'Phase-2: NZB response received');
      if (!response.ok) {
        logger.warn(
          { title: result.title, status: response.status, url: safeUrl },
          'NZB fetch failed with non-OK status',
        );
        if (tryTitleFallback(result, logger)) languagesDetected++;
        // Short failure TTL: a transient indexer error self-heals after ~1h.
        // Preserve any title-fallback language; nzbName stays absent (came from
        // the title, not the NZB body) so a later success can populate it.
        enrichmentCache.set(cacheKey, { outcome: 'fetch-failed', language: result.language, nzbName: undefined });
        return;
      }
      const xml = await response.text();

      // Extract NZB name (meta tag first, file subject as fallback)
      const nzbName = parseNzbName(xml) || parseNzbFileSubject(xml);
      if (nzbName) result.nzbName = nzbName;
      const groups = parseNzbGroups(xml);

      // Capture only the specific fields we need — never log the full XML body
      // (NZBs commonly carry <meta type="password"> RAR/par2 archive passwords).
      logger.debug({
        title: result.title,
        groupCount: groups.length,
        groups,
        parsedNzbName: parseNzbName(xml) || null,
        fileSubject: result.nzbName,
      }, 'Phase-2: NZB parsed');

      // Walk the detection signals in priority order — newsgroup → nzbName → title.
      // Guarded on result.language so earlier signals win; the title fallback
      // is defense-in-depth for cases where uploaders strip parenthetical
      // language markers like (Ungekürzt) from the NZB meta name.
      const source = detectPhase2Source(result, groups, logger);
      if (source !== 'unresolved') languagesDetected++;

      // Cache the successful outcome under the long TTL. `unresolved` (no signal
      // matched) is cached too — a stored `undefined` language is a HIT, so it
      // is never re-fetched within the TTL. nzbName is preserved either way.
      enrichmentCache.set(cacheKey, {
        outcome: source === 'unresolved' ? 'unresolved' : 'resolved',
        language: result.language,
        nzbName: result.nzbName,
      });

      logger.debug({
        title: result.title,
        finalLanguage: result.language ?? null,
        source,
      }, 'Phase-2: enrichment complete');
    } catch (error: unknown) {
      logger.warn(
        { title: result.title, url: safeUrl, error: serializeError(error) },
        'NZB fetch failed',
      );
      if (tryTitleFallback(result, logger)) languagesDetected++;
      enrichmentCache.set(cacheKey, { outcome: 'fetch-failed', language: result.language, nzbName: undefined });
    } finally {
      await dispatcher.close().catch(() => { /* best-effort cleanup */ });
      semaphore.release();
    }
  }

  await Promise.all(toFetch.map((r) => fetchAndEnrich(r)));

  const totalFetchMs = Date.now() - startMs;
  logger.info(
    { usenetResults: usenetResults.length, nzbFetched, languagesDetected, totalFetchMs },
    'Usenet language detection complete',
  );
}
