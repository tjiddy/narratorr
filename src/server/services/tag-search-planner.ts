import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { TagQuery } from './match-job.helpers.js';
import { cleanTagTitle } from '../utils/folder-parsing.js';

export const MAX_TAG_SEARCH_ATTEMPTS = 5;

export type AttemptSource =
  | 'asin-tag'
  | 'exact'
  | 'album'
  | 'strip-trailing-part'
  | 'strip-leading-series'
  | 'strip-colon-suffix';

export interface TagSearchAttempt {
  title: string;
  author: string;
  source: AttemptSource;
  /** Caps the final match-job confidence regardless of scoring. */
  maxConfidence: 'high' | 'medium';
}

/** Output of `runTagSearch` — ranked candidates plus the winning attempt for confidence-cap propagation. */
export interface TagSearchOutcome {
  scored: { meta: BookMetadata; score: number }[];
  attempt: TagSearchAttempt;
}

/**
 * Plan an ordered sequence of tag-search attempts. The first attempt is the
 * cleaned tag title (existing #984 behavior); subsequent attempts strip
 * common annotation noise that over-specifies Audible's `title=` search.
 *
 * Attempts are deduplicated by lowercased+trimmed title; identical titles
 * (e.g. `tagQuery.title === albumCandidate`) collapse to a single entry.
 *
 * Capped at MAX_TAG_SEARCH_ATTEMPTS to bound provider load on wide tag noise.
 */
export function planTagSearchAttempts(
  audioResult: AudioScanResult,
  tagQuery: TagQuery,
): TagSearchAttempt[] {
  const attempts: TagSearchAttempt[] = [];
  const seen = new Set<string>();

  function add(attempt: TagSearchAttempt): void {
    const key = attempt.title.toLowerCase().trim();
    if (key && !seen.has(key) && attempts.length < MAX_TAG_SEARCH_ATTEMPTS) {
      seen.add(key);
      attempts.push(attempt);
    }
  }

  add({ title: tagQuery.title, author: tagQuery.author, source: 'exact', maxConfidence: 'high' });

  const albumTitle = deriveAlbumCandidate(audioResult);
  if (albumTitle) {
    add({ title: albumTitle, author: tagQuery.author, source: 'album', maxConfidence: 'medium' });
  }

  const stripTrailingPart = tagQuery.title.replace(/\s*-\s*Part\s+\d+\s*$/i, '').trim();
  if (stripTrailingPart && stripTrailingPart !== tagQuery.title) {
    add({ title: stripTrailingPart, author: tagQuery.author, source: 'strip-trailing-part', maxConfidence: 'medium' });
  }

  const stripLeadingSeries = tagQuery.title
    .replace(/^[A-Za-z][\w\s'-]*?\s+\d+(?:\.\d+)?\s*[-–—]\s*/, '')
    .trim();
  if (stripLeadingSeries && stripLeadingSeries !== tagQuery.title) {
    add({ title: stripLeadingSeries, author: tagQuery.author, source: 'strip-leading-series', maxConfidence: 'medium' });
  }

  const colonIdx = tagQuery.title.indexOf(':');
  if (colonIdx > 0) {
    const stripColonSuffix = tagQuery.title.slice(0, colonIdx).trim();
    if (stripColonSuffix && stripColonSuffix.length >= 3) {
      add({ title: stripColonSuffix, author: tagQuery.author, source: 'strip-colon-suffix', maxConfidence: 'medium' });
    }
  }

  return attempts;
}

/**
 * Build the album-derived candidate title. The cleanup order is load-bearing:
 *
 * 1. Strip a trailing dash-series-keyword annotation (`- <series-keyword> ..., Book N`)
 *    while `, Book N` is still present — that suffix is the safety gate. Without
 *    it, legitimate `- Special Edition, Book 1` from `The Hobbit - Special
 *    Edition, Book 1` would risk being stripped.
 * 2. Run `cleanTagTitle` for standard cleanup (bracket strip, edition-paren-aware
 *    narrator strip, residual `, Book N` removal).
 *
 * `cleanTagTitle` strips trailing `, Book N` (TAG_TITLE_SERIES_MARKER_REGEX),
 * so the dash-series-keyword strip MUST run first. Reversing the order causes
 * `Imagine Me - Shatter Me Series, Book 6` → `Imagine Me - Shatter Me Series`
 * instead of `Imagine Me`.
 */
function deriveAlbumCandidate(audioResult: AudioScanResult): string | null {
  const album = audioResult.tagAlbum?.trim();
  if (!album) return null;

  let cleaned = album.replace(
    /\s*-\s*[^-]+?(?:series|saga|trilogy|cycle|chronicles)\s*[^-]*,\s*Book\s+\d+(?:\.\d+)?\s*$/i,
    '',
  ).trim();

  cleaned = cleanTagTitle(cleaned);

  return cleaned.length >= 3 ? cleaned : null;
}
