import { basename } from 'node:path';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import { scoreResult } from '../../core/utils/similarity.js';
import { cleanTagTitle, extractYear } from '../utils/folder-parsing.js';
import type { Confidence, MatchCandidate } from './match-job.service.js';

const DURATION_THRESHOLD_STRICT = 0.05;
const DURATION_THRESHOLD_RELAXED = 0.15;
const COMBINED_SCORE_GATE = 0.95;

export interface DurationConfidenceResult {
  confidence: Confidence;
  reason?: string;
}

/** Format minutes as hours with 1 decimal place. */
function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(1);
}

/**
 * Determines confidence from duration data without overriding the similarity-ranked winner.
 * The bestMatch stays as the top similarity-ranked result; duration only affects confidence level.
 */
export function resolveConfidenceFromDuration(
  scored: { meta: BookMetadata; score: number }[],
  duration: number | undefined,
): DurationConfidenceResult {
  if (!duration || duration <= 0) {
    return { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate' };
  }
  const topResult = scored[0]!;
  if (topResult.meta.duration && topResult.meta.duration > 0) {
    const distance = Math.abs(topResult.meta.duration - duration) / duration;
    const threshold = topResult.score >= COMBINED_SCORE_GATE ? DURATION_THRESHOLD_RELAXED : DURATION_THRESHOLD_STRICT;
    if (distance <= threshold) return { confidence: 'high' };
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatHours(duration)}hrs vs expected ${formatHours(topResult.meta.duration)}hrs`,
    };
  }
  return { confidence: 'medium', reason: 'Best match missing duration — cannot verify' };
}

/**
 * Build a tag-derived search query from the AudioScanResult, applying
 * cleanTagTitle to tagTitle. Returns null when the scan lacks usable tags
 * (missing title or author after trimming) — caller falls through to Pass 2.
 */
export function deriveTagQuery(audioResult: AudioScanResult | null): { title: string; author: string } | null {
  if (!audioResult) return null;
  const rawTitle = audioResult.tagTitle?.trim();
  const rawAuthor = audioResult.tagAuthor?.trim();
  if (!rawTitle || !rawAuthor) return null;
  const cleanedTitle = cleanTagTitle(rawTitle).trim();
  if (!cleanedTitle) return null;
  return { title: cleanedTitle, author: rawAuthor };
}

/**
 * Tag-pass scoring: applies cleanTagTitle to BOTH the result title and the
 * input title before dice scoring (AC7). The input context is already cleaned
 * in deriveTagQuery; here we only need to normalize the result side.
 */
export function rankResultsCleaned(
  detailed: BookMetadata[],
  tagQuery: { title: string; author: string },
): { meta: BookMetadata; score: number }[] {
  const scored = detailed.map(meta => ({
    meta,
    score: scoreResult(
      {
        ...(meta.title !== undefined && { title: cleanTagTitle(meta.title) }),
        ...(meta.authors?.[0]?.name !== undefined && { author: meta.authors[0].name }),
      },
      tagQuery,
    ),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Scores and ranks results by title+author similarity with year tiebreaker. */
export function rankResults(
  detailed: BookMetadata[],
  book: MatchCandidate,
): { meta: BookMetadata; score: number }[] {
  const context = { title: book.title, ...(book.author !== undefined && { author: book.author }) };
  const scored = detailed.map(meta => ({
    meta,
    score: scoreResult(
      { title: meta.title, ...(meta.authors?.[0]?.name !== undefined && { author: meta.authors[0].name }) },
      context,
    ),
  }));

  const folderYear = extractYear(basename(book.path));
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 0.001 && folderYear) {
      const aYear = parsePublishedYear(a.meta.publishedDate);
      const bYear = parsePublishedYear(b.meta.publishedDate);
      const aMatch = aYear === folderYear ? 1 : 0;
      const bMatch = bYear === folderYear ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return b.score - a.score;
  });
  return scored;
}

function parsePublishedYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const match = date.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1]!, 10) : undefined;
}
