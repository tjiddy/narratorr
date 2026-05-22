import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/indexers/types.js';
import { normalizeLanguage } from '../../core/utils/language-codes.js';
import { detectLanguageFromNewsgroup, detectLanguageFromText, parseNzbGroups, parseNzbName, parseNzbFileSubject } from '../../core/utils/detect-usenet-language.js';
import { createSsrfSafeDispatcher, fetchWithSsrfRedirect } from '../../core/utils/network-service.js';
import { Semaphore } from './semaphore.js';
import { serializeError } from './serialize-error.js';
import { sanitizeLogUrl } from './sanitize-log-url.js';

const NZB_FETCH_CONCURRENCY = 5;
const NZB_FETCH_TIMEOUT_MS = 5000;

type Phase2Source = 'newsgroup' | 'name' | 'title' | 'unresolved';

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
 * Mutates results in-place. Non-blocking: fetch failures are logged and skipped.
 */
export async function enrichUsenetLanguages(
  results: SearchResult[],
  logger: FastifyBaseLogger,
): Promise<void> {
  const startMs = Date.now();
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

  // Phase 2: Fetch NZBs in parallel with concurrency limit
  const semaphore = new Semaphore(NZB_FETCH_CONCURRENCY);

  async function fetchAndEnrich(result: SearchResult): Promise<void> {
    await semaphore.acquire();
    nzbFetched++;
    const dispatcher = createSsrfSafeDispatcher();
    const safeUrl = sanitizeLogUrl(result.downloadUrl!);
    try {
      logger.debug({ title: result.title, url: safeUrl }, 'Phase-2: fetching NZB');
      const response = await fetchWithSsrfRedirect(result.downloadUrl!, {
        dispatcher,
        timeoutMs: NZB_FETCH_TIMEOUT_MS,
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
    } finally {
      await dispatcher.close().catch(() => { /* best-effort cleanup */ });
      semaphore.release();
    }
  }

  await Promise.all(needsFetch.map((r) => fetchAndEnrich(r)));

  const totalFetchMs = Date.now() - startMs;
  logger.info(
    { usenetResults: usenetResults.length, nzbFetched, languagesDetected, totalFetchMs },
    'Usenet language detection complete',
  );
}
