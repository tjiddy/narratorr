import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { deriveFfprobePath } from '../../core/utils/ffprobe-path.js';
import type { SettingsService } from './settings.service.js';
import { Semaphore } from '../utils/semaphore.js';
import { scoreResult, diceCoefficient } from '../../core/utils/similarity.js';
import { extractYear } from './library-scan.service.js';
import { searchWithSwapRetry } from '../utils/search-helpers.js';

// ============ Types ============

export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
}

// ============ Service ============

const MAX_CONCURRENCY = 5;
const TTL_MS = 10 * 60 * 1000; // 10 minutes after completion
const DURATION_THRESHOLD_STRICT = 0.05; // 5% tolerance for weaker matches
const DURATION_THRESHOLD_RELAXED = 0.15; // 15% tolerance for high-confidence matches
const COMBINED_SCORE_GATE = 0.95; // Score threshold for relaxed duration matching
const TITLE_SIMILARITY_FLOOR = 0.5; // Below this, confidence is 'none'

export class MatchJobService {
  private jobs = new Map<string, MatchJob>();

  constructor(
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
    private settingsService: SettingsService,
  ) {}

  createJob(books: MatchCandidate[]): string {
    const id = randomUUID();
    const job = new MatchJob(id, books, this.metadataService, this.log, this.settingsService, () => {
      this.scheduleCleanup(id);
    });
    this.jobs.set(id, job);
    job.start();
    this.log.info({ jobId: id, bookCount: books.length }, 'Match job created');
    return id;
  }

  getJob(jobId: string): MatchJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return job.getStatus();
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.cancel();
    this.log.info({ jobId }, 'Match job cancelled');
    return true;
  }

  /** Clean up expired jobs (called internally on TTL) */
  private removeJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.log.debug({ jobId }, 'Match job expired and removed');
  }

  private scheduleCleanup(jobId: string): void {
    setTimeout(() => this.removeJob(jobId), TTL_MS);
  }
}

class MatchJob {
  private results: MatchResult[] = [];
  private cancelled = false;
  private done = false;
  private startMs = Date.now();
  private semaphore = new Semaphore(MAX_CONCURRENCY);

  constructor(
    private id: string,
    private books: MatchCandidate[],
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
    private settingsService: SettingsService,
    private onComplete: () => void,
  ) {}

  getStatus(): MatchJobStatus {
    return {
      id: this.id,
      status: this.cancelled ? 'cancelled' : this.done ? 'completed' : 'matching',
      total: this.books.length,
      matched: this.results.length,
      results: [...this.results],
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  start(): void {
    this.run().catch(error => {
      this.log.error({ error, jobId: this.id }, 'Match job failed unexpectedly');
    });
  }

  private async run(): Promise<void> {
    const promises = this.books.map(book => this.matchWithSemaphore(book));
    await Promise.allSettled(promises);
    this.done = true;

    this.log.info(
      {
        jobId: this.id,
        total: this.books.length,
        matched: this.results.filter(r => r.confidence !== 'none').length,
        cancelled: this.cancelled,
        elapsedMs: Date.now() - this.startMs,
      },
      'Match job finished',
    );

    this.onComplete();
  }

  private async matchWithSemaphore(book: MatchCandidate): Promise<void> {
    if (this.cancelled) return;
    await this.semaphore.acquire();
    try {
      if (this.cancelled) return;
      const result = await this.matchSingleBook(book);
      this.results.push(result);
    } finally {
      this.semaphore.release();
    }
  }

  async matchSingleBook(book: MatchCandidate): Promise<MatchResult> {
    try {
      // Scan audio files for duration (used for runtime disambiguation)
      let duration: number | undefined;
      try {
        const processingSettings = await this.settingsService.get('processing');
        const ffprobePath = processingSettings?.ffmpegPath?.trim() ? deriveFfprobePath(processingSettings.ffmpegPath.trim()) : undefined;
        const audioResult = await scanAudioDirectory(book.path, { skipCover: true, ffprobePath, log: this.log });
        if (audioResult && audioResult.totalDuration > 0) {
          // Convert seconds → minutes to match Audible's runtime_length_min
          duration = Math.round(audioResult.totalDuration / 60);
          this.log.debug({ path: book.path, duration: `${duration}min` }, 'Audio duration scanned');
        }
      } catch (error: unknown) {
        this.log.debug({ error, path: book.path }, 'Audio scan failed — proceeding without duration');
      }

      // Send structured search params when title/author available, with swap retry
      this.log.debug({ path: book.path, title: book.title, author: book.author, duration }, 'Searching metadata for book');
      const searchResults = await searchWithSwapRetry({
        searchFn: (q, opts) => this.metadataService.searchBooks(q, opts),
        title: book.title,
        author: book.author,
        log: this.log,
        options: { title: book.title, author: book.author },
      });

      if (searchResults.length === 0) {
        this.log.debug({ path: book.path }, 'No search results returned');
        return { path: book.path, confidence: 'none', bestMatch: null, alternatives: [] };
      }

      this.log.debug({ path: book.path, resultCount: searchResults.length }, 'Search returned results');

      // Fetch full detail for all results to get ASIN/duration
      const detailed = await this.fetchDetails(searchResults);

      // Score, re-rank, and apply year tiebreaker
      const scored = rankResults(detailed, book);
      const topScored = scored[0];

      // Title similarity floor: below 50% → confidence 'none'
      const titleSimilarity = book.title && topScored.meta.title
        ? diceCoefficient(topScored.meta.title, book.title)
        : 0;
      if (titleSimilarity < TITLE_SIMILARITY_FLOOR) {
        this.log.debug(
          { path: book.path, titleSimilarity: titleSimilarity.toFixed(2), bestTitle: topScored.meta.title },
          'Top result below title similarity floor — none confidence',
        );
        return {
          path: book.path,
          confidence: 'none',
          bestMatch: topScored.meta,
          alternatives: scored.slice(1).map(s => s.meta),
        };
      }

      if (scored.length === 1) {
        this.log.debug({ path: book.path, title: topScored.meta.title, score: topScored.score.toFixed(2) }, 'Single result — high confidence');
        return {
          path: book.path,
          confidence: 'high',
          bestMatch: topScored.meta,
          alternatives: [],
        };
      }

      // Multiple results — use duration to determine confidence (not to override winner)
      const { confidence, reason } = resolveConfidenceFromDuration(scored, duration);
      this.log.debug(
        {
          path: book.path,
          confidence,
          resultCount: scored.length,
          topScore: topScored.score.toFixed(2),
          bestTitle: topScored.meta.title,
          hasDuration: !!duration,
          matchDuration: topScored.meta.duration,
        },
        confidence === 'high' ? 'Duration-verified high confidence' : reason ?? 'Multiple results — medium confidence',
      );
      return {
        path: book.path,
        confidence,
        reason,
        bestMatch: topScored.meta,
        alternatives: scored.slice(1).map(s => s.meta),
      };
    } catch (error: unknown) {
      this.log.warn({ error, path: book.path, title: book.title }, 'Match failed for book');
      return {
        path: book.path,
        confidence: 'none',
        bestMatch: null,
        alternatives: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async fetchDetails(results: BookMetadata[]): Promise<BookMetadata[]> {
    const detailed: BookMetadata[] = [];
    for (const result of results) {
      if (this.cancelled) break;
      if (result.providerId && !result.asin) {
        try {
          this.log.debug({ providerId: result.providerId, title: result.title }, 'Fetching full detail for candidate');
          const detail = await this.metadataService.getBook(result.providerId);
          if (detail) {
            this.log.debug({ providerId: result.providerId, asin: detail.asin, duration: detail.duration }, 'Detail fetched');
            detailed.push({ ...result, ...detail, title: result.title });
            continue;
          }
        } catch (error: unknown) {
          this.log.debug({ error, providerId: result.providerId }, 'Detail fetch failed, using search result');
        }
      }
      detailed.push(result);
    }
    return detailed;
  }
}

/** Format minutes as hours with 1 decimal place. */
function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(1);
}

interface DurationConfidenceResult {
  confidence: Confidence;
  reason?: string;
}

/**
 * Determines confidence from duration data without overriding the similarity-ranked winner.
 * The bestMatch stays as the top similarity-ranked result; duration only affects confidence level.
 */
function resolveConfidenceFromDuration(
  scored: { meta: BookMetadata; score: number }[],
  duration: number | undefined,
): DurationConfidenceResult {
  if (!duration || duration <= 0) {
    return { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate' };
  }

  const topResult = scored[0];
  // If the top-ranked result has duration data, use it for confidence
  if (topResult.meta.duration && topResult.meta.duration > 0) {
    const distance = Math.abs(topResult.meta.duration - duration) / duration;
    const threshold = topResult.score >= COMBINED_SCORE_GATE
      ? DURATION_THRESHOLD_RELAXED
      : DURATION_THRESHOLD_STRICT;
    if (distance <= threshold) {
      return { confidence: 'high' };
    }
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatHours(duration)}hrs vs expected ${formatHours(topResult.meta.duration)}hrs`,
    };
  }

  // Top result has no duration — cannot verify
  return { confidence: 'medium', reason: 'Best match missing duration — cannot verify' };
}

/** Scores and ranks results by title+author similarity with year tiebreaker. */
function rankResults(
  detailed: BookMetadata[],
  book: MatchCandidate,
): { meta: BookMetadata; score: number }[] {
  const context = { title: book.title, author: book.author };
  const scored = detailed.map(meta => ({
    meta,
    score: scoreResult(
      { title: meta.title, author: meta.authors?.[0]?.name },
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

/** Extracts a 4-digit year from a publishedDate string (e.g., "2011-06-14" → 2011). */
function parsePublishedYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const match = date.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}
