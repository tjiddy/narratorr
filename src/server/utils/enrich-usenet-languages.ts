import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/indexers/types.js';
import { normalizeLanguage } from '@core/utils/language-codes.js';
import { detectLanguageFromNewsgroup, detectLanguageFromText, parseNzbGroups, parseNzbName, parseNzbFileSubject } from '@core/utils/detect-usenet-language.js';
import { createSsrfSafeDispatcher, fetchWithSsrfRedirect } from '@core/utils/network-service.js';
import type { LanAllowlist } from '@core/utils/download-url.js';
import { getUserAgent } from '@shared/user-agent.js';
import { Semaphore } from './semaphore.js';
import { serializeError } from './serialize-error.js';
import { sanitizeLogUrl } from './sanitize-log-url.js';
import { enrichmentCache, type EnrichmentCacheValue } from './enrichment-cache.js';

const NZB_FETCH_CONCURRENCY = 5;
const NZB_FETCH_TIMEOUT_MS = 5000;

// Auto-grab paths cap Phase 2; interactive post-processing remains uncapped.
export const AUTO_GRAB_PHASE2_CAP = 10;

type Phase2Source = 'newsgroup' | 'name' | 'title' | 'unresolved';

export interface EnrichUsenetOptions {
  /** After cache lookup, fetch only the top N by matchScore, seeders, then grabs; omit for uncapped. */
  maxPhase2Fetches?: number;
}

// Namespace free-form GUIDs by indexer to prevent cross-indexer cache collisions.
// `||` intentionally falls back from an empty GUID to URL; no release key means no cache entry.
function cacheKeyFor(result: SearchResult): string | undefined {
  const releaseKey = result.guid || result.downloadUrl;
  return releaseKey ? `${result.indexerId ?? result.indexer}:${releaseKey}` : undefined;
}

// Branch instead of subtracting: -Infinity - -Infinity is NaN.
function cmpDesc(a: number | undefined, b: number | undefined): number {
  const av = a ?? -Infinity;
  const bv = b ?? -Infinity;
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
}

function comparePhase2(a: SearchResult, b: SearchResult): number {
  return cmpDesc(a.matchScore, b.matchScore)
    || cmpDesc(a.seeders, b.seeders)
    || cmpDesc(a.grabs, b.grabs);
}

// Reapply cached nzbName so the downstream multi-part filter still sees it on a hit.
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

// A live entry with undefined language is still a hit; only absent entries are misses.
function consultCache(
  needsFetch: SearchResult[],
  logger: FastifyBaseLogger,
): { misses: SearchResult[]; hitsDetected: number; cacheHits: number } {
  const misses: SearchResult[] = [];
  let hitsDetected = 0;
  let cacheHits = 0;
  for (const result of needsFetch) {
    const key = cacheKeyFor(result);
    const entry = key ? enrichmentCache.get(key) : undefined;
    if (entry) {
      // cacheHits counts all live entries; hitsDetected only entries that set language.
      cacheHits++;
      if (applyCacheHit(result, entry, logger)) hitsDetected++;
    } else {
      misses.push(result);
    }
  }
  return { misses, hitsDetected, cacheHits };
}

function selectCappedCandidates(
  candidates: SearchResult[],
  cap: number | undefined,
  logger: FastifyBaseLogger,
): { toFetch: SearchResult[]; skipped: SearchResult[] } {
  if (cap === undefined) return { toFetch: candidates, skipped: [] };
  // Clamp before slice: negative values invert the cap and fractions coerce implicitly.
  const effectiveCap = Math.max(0, Math.floor(cap));
  if (candidates.length <= effectiveCap) return { toFetch: candidates, skipped: [] };
  const ranked = [...candidates].sort(comparePhase2);
  logger.debug(
    { candidates: candidates.length, cap: effectiveCap, skipped: candidates.length - effectiveCap },
    'Phase-2 fetch cap applied — skipped lowest-ranked candidates',
  );
  return { toFetch: ranked.slice(0, effectiveCap), skipped: ranked.slice(effectiveCap) };
}

// Group before the cap so duplicates consume one slot; the highest-ranked member represents each key.
function groupMissesByKey(
  misses: SearchResult[],
): { groups: Map<string, SearchResult[]>; representatives: SearchResult[] } {
  const groups = new Map<string, SearchResult[]>();
  for (const result of misses) {
    const key = cacheKeyFor(result)!;
    const existing = groups.get(key);
    if (existing) existing.push(result);
    else groups.set(key, [result]);
  }
  const representatives: SearchResult[] = [];
  for (const group of groups.values()) {
    representatives.push(group.length === 1 ? group[0]! : [...group].sort(comparePhase2)[0]!);
  }
  return { groups, representatives };
}

// Copy only missing observable fields; the cache outcome remains representative-only.
function propagateToGroup(rep: SearchResult, group: SearchResult[], logger: FastifyBaseLogger): number {
  let detected = 0;
  for (const member of group) {
    if (member === rep) continue;
    if (rep.language && !member.language) {
      member.language = rep.language;
      detected++;
    }
    if (rep.nzbName && !member.nzbName) member.nzbName = rep.nzbName;
    logger.debug(
      { title: member.title, signal: 'within-run-dup', language: rep.language ?? null },
      'Phase-2: duplicate result enriched from representative (no separate fetch)',
    );
  }
  return detected;
}

function propagateDuplicates(
  representatives: SearchResult[],
  groups: Map<string, SearchResult[]>,
  logger: FastifyBaseLogger,
): number {
  let detected = 0;
  for (const rep of representatives) {
    const group = groups.get(cacheKeyFor(rep)!)!;
    if (group.length > 1) detected += propagateToGroup(rep, group, logger);
  }
  return detected;
}

// The cap limits network only; skipped candidates still get free title detection.
// Do not cache title-only outcomes—a later run must still fetch NZB metadata.
function detectCapSkippedTitles(skipped: SearchResult[], logger: FastifyBaseLogger): number {
  let detected = 0;
  for (const result of skipped) {
    if (result.language) continue;
    const titleLang = normalizeLanguage(detectLanguageFromText(result.title));
    if (!titleLang) continue;
    result.language = titleLang;
    detected++;
    logger.debug(
      { title: result.title, signal: 'title-cap-skipped', matched: titleLang },
      'Language detected from title for cap-skipped candidate (no NZB fetch)',
    );
  }
  return detected;
}

// Fetch failures still get title detection without overwriting an earlier signal.
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

// First match wins: newsgroup → NZB name → title.
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
 * Mutates Usenet results in place; fetch failures are logged and skipped.
 * lanAllowlist permits a configured private indexer while redirect hops remain SSRF-checked.
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

  const usenetResults = results.filter(
    (r) => r.protocol === 'usenet' && !r.language,
  );

  // Fetch generic newsgroups too, because downstream filtering still needs nzbName.
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
        logger.debug({ title: result.title, newsgroup: result.newsgroup }, 'Phase-1: newsgroup generic, falling through to NZB fetch');
        needsFetch.push(result);
      } else {
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

  const { misses, hitsDetected, cacheHits } = consultCache(needsFetch, logger);
  languagesDetected += hitsDetected;

  const { groups, representatives } = groupMissesByKey(misses);

  const { toFetch, skipped } = selectCappedCandidates(representatives, options?.maxPhase2Fetches, logger);
  const capSkipped = skipped.length;

  languagesDetected += detectCapSkippedTitles(skipped, logger);

  const semaphore = new Semaphore(NZB_FETCH_CONCURRENCY);

  async function fetchAndEnrich(result: SearchResult): Promise<void> {
    const release = await semaphore.acquire();
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
        // Cache title fallback but leave nzbName empty so a later successful fetch can populate it.
        enrichmentCache.set(cacheKey, { outcome: 'fetch-failed', language: result.language, nzbName: undefined });
        return;
      }
      const xml = await response.text();

      const nzbName = parseNzbName(xml) || parseNzbFileSubject(xml);
      if (nzbName) result.nzbName = nzbName;
      const groups = parseNzbGroups(xml);

      // Never log NZB XML; it commonly contains archive passwords.
      logger.debug({
        title: result.title,
        groupCount: groups.length,
        groups,
        parsedNzbName: parseNzbName(xml) || null,
        fileSubject: result.nzbName,
      }, 'Phase-2: NZB parsed');

      const source = detectPhase2Source(result, groups, logger);
      if (source !== 'unresolved') languagesDetected++;

      // Cache unresolved results too; undefined language is still a hit.
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
      release();
    }
  }

  await Promise.all(toFetch.map((r) => fetchAndEnrich(r)));

  languagesDetected += propagateDuplicates(representatives, groups, logger);

  const totalFetchMs = Date.now() - startMs;
  logger.info(
    { usenetResults: usenetResults.length, nzbFetched, languagesDetected, cacheHits, capSkipped, totalFetchMs },
    'Usenet language detection complete',
  );
}
