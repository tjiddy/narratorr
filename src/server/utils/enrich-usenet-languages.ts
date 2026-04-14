import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/indexers/types.js';
import { normalizeLanguage } from '../../core/utils/language-codes.js';
import { detectLanguageFromNewsgroup, detectLanguageFromNzbName, parseNzbGroups, parseNzbName, parseNzbFileSubject } from '../../core/utils/detect-usenet-language.js';
import { fetchWithTimeout } from '../../core/utils/fetch-with-timeout.js';
import { Semaphore } from './semaphore.js';
import { getErrorMessage } from './error-message.js';
import { sanitizeLogUrl } from './sanitize-log-url.js';

const NZB_FETCH_CONCURRENCY = 5;
const NZB_FETCH_TIMEOUT_MS = 5000;

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
    if (result.newsgroup) {
      const lang = normalizeLanguage(detectLanguageFromNewsgroup(result.newsgroup));
      if (lang) {
        result.language = lang;
        languagesDetected++;
      } else if (result.downloadUrl) {
        // Generic newsgroup (e.g., alt.binaries.audiobooks) — fall through to NZB fetch
        // so nzbName is populated for reject/required word filtering and name-based language detection
        needsFetch.push(result);
      }
    } else if (result.downloadUrl) {
      needsFetch.push(result);
    }
  }

  // Phase 2: Fetch NZBs in parallel with concurrency limit
  const semaphore = new Semaphore(NZB_FETCH_CONCURRENCY);

  async function fetchAndEnrich(result: SearchResult): Promise<void> {
    await semaphore.acquire();
    nzbFetched++;
    try {
      const response = await fetchWithTimeout(result.downloadUrl!, {}, NZB_FETCH_TIMEOUT_MS);
      if (!response.ok) {
        logger.warn(
          { title: result.title, status: response.status, url: sanitizeLogUrl(result.downloadUrl!) },
          'NZB fetch failed with non-OK status',
        );
        return;
      }
      const xml = await response.text();

      // Extract NZB name (meta tag first, file subject as fallback)
      result.nzbName = parseNzbName(xml) || parseNzbFileSubject(xml) || undefined;

      // Detect language from newsgroups first
      const groups = parseNzbGroups(xml);
      let langDetected = false;
      for (const group of groups) {
        const lang = normalizeLanguage(detectLanguageFromNewsgroup(group));
        if (lang) {
          result.language = lang;
          languagesDetected++;
          langDetected = true;
          break;
        }
      }

      // Fall back to NZB name for language detection
      if (!langDetected) {
        const nameLang = normalizeLanguage(detectLanguageFromNzbName(result.nzbName));
        if (nameLang) {
          result.language = nameLang;
          languagesDetected++;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        { title: result.title, url: sanitizeLogUrl(result.downloadUrl!), error: getErrorMessage(error) },
        'NZB fetch failed',
      );
    } finally {
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
