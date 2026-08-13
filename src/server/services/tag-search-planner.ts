import type { AudioScanResult } from '@core/utils/audio-scanner.js';
import type { BookMetadata } from '@core/metadata/index.js';
import type { TagQuery } from './match-job.helpers.js';
import { cleanTagTitle } from '../utils/folder-parsing.js';

export const MAX_TAG_SEARCH_ATTEMPTS = 5;

export type AttemptSource =
  | 'asin-opf'
  | 'asin-tag'
  | 'exact'
  | 'album'
  | 'strip-trailing-part'
  | 'strip-leading-series'
  | 'strip-colon-suffix';

export type MatchSource = AttemptSource | 'filename-single' | 'filename-duration-resolved';

export interface TagSearchAttempt {
  title: string;
  author: string;
  source: AttemptSource;
  /** Caps the final match-job confidence regardless of scoring. */
  maxConfidence: 'high' | 'medium';
}

export interface TagSearchOutcome {
  scored: { meta: BookMetadata; score: number }[];
  attempt: TagSearchAttempt;
}

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
 * Strip dash-series annotations before cleanTagTitle removes the `Book N` safety gate;
 * reversing that order leaves the series suffix behind and can over-strip editions.
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
