import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../indexers/types.js';
import { normalizeLanguage } from './language-codes.js';
import { Semaphore } from '../../server/utils/semaphore.js';

/** Static token-to-language map for Usenet newsgroup names. */
const NEWSGROUP_TOKEN_MAP: Record<string, string> = {
  german: 'german',
  deutsch: 'german',
  hoerbuecher: 'german',
  hoerspiele: 'german',
  french: 'french',
  francais: 'french',
  dutch: 'dutch',
  nederlands: 'dutch',
  audioboeken: 'dutch',
  luisterboeken: 'dutch',
  spanish: 'spanish',
  italian: 'italian',
  italiano: 'italian',
  japanese: 'japanese',
  nihongo: 'japanese',
};

const NZB_FETCH_CONCURRENCY = 5;
const NZB_FETCH_TIMEOUT_MS = 5000;

/**
 * Detect language from a newsgroup name by splitting on '.' and matching tokens.
 * First match wins. Returns undefined when no language token is found.
 */
export function detectLanguageFromNewsgroup(group: string | undefined): string | undefined {
  if (!group) return undefined;
  const tokens = group.split('.');
  for (const token of tokens) {
    if (!token) continue;
    const lang = NEWSGROUP_TOKEN_MAP[token.toLowerCase()];
    if (lang) return lang;
  }
  return undefined;
}

/**
 * Parse NZB XML and extract all <group> text values.
 * Returns empty array on parse failure or missing groups.
 */
export function parseNzbGroups(xml: string): string[] {
  const groups: string[] = [];
  // Simple regex extraction — NZB <group> tags are plain text, no nesting
  const groupRegex = /<group>([^<]+)<\/group>/gi;
  let match: RegExpExecArray | null;
  while ((match = groupRegex.exec(xml)) !== null) {
    const text = match[1].trim();
    if (text) groups.push(text);
  }
  return groups;
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

  // Phase 1: Short-circuit on existing newsgroup field
  const needsFetch: SearchResult[] = [];
  for (const result of usenetResults) {
    if (result.newsgroup) {
      const lang = normalizeLanguage(detectLanguageFromNewsgroup(result.newsgroup));
      if (lang) {
        result.language = lang;
        languagesDetected++;
      }
      // Do not fall back to NZB fetch — same source
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
      const response = await fetch(result.downloadUrl!, {
        signal: AbortSignal.timeout(NZB_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn(
          { title: result.title, status: response.status, url: result.downloadUrl },
          'NZB fetch failed with non-OK status',
        );
        return;
      }
      const xml = await response.text();
      const groups = parseNzbGroups(xml);
      for (const group of groups) {
        const lang = normalizeLanguage(detectLanguageFromNewsgroup(group));
        if (lang) {
          result.language = lang;
          languagesDetected++;
          break;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        { title: result.title, url: result.downloadUrl, error: error instanceof Error ? error.message : String(error) },
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
