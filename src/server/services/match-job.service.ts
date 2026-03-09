import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { Semaphore } from '../utils/semaphore.js';

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
const DURATION_THRESHOLD = 0.05; // 5% tolerance for duration matching

export class MatchJobService {
  private jobs = new Map<string, MatchJob>();

  constructor(
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
  ) {}

  createJob(books: MatchCandidate[]): string {
    const id = randomUUID();
    const job = new MatchJob(id, books, this.metadataService, this.log, () => {
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
  private semaphore = new Semaphore(MAX_CONCURRENCY);

  constructor(
    private id: string,
    private books: MatchCandidate[],
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
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
        const audioResult = await scanAudioDirectory(book.path, { skipCover: true });
        if (audioResult && audioResult.totalDuration > 0) {
          // Convert seconds → minutes to match Audible's runtime_length_min
          duration = Math.round(audioResult.totalDuration / 60);
          this.log.debug({ path: book.path, duration: `${duration}min` }, 'Audio duration scanned');
        }
      } catch (error) {
        this.log.debug({ error, path: book.path }, 'Audio scan failed — proceeding without duration');
      }

      const query = book.author ? `${book.title} ${book.author}` : book.title;
      this.log.debug({ path: book.path, query, duration }, 'Searching metadata for book');
      const searchResults = await this.metadataService.searchBooks(query);

      if (searchResults.length === 0) {
        this.log.debug({ path: book.path, query }, 'No search results returned');
        return { path: book.path, confidence: 'none', bestMatch: null, alternatives: [] };
      }

      this.log.debug({ path: book.path, resultCount: searchResults.length }, 'Search returned results');

      // Fetch full detail for top results to get ASIN/duration
      const detailed = await this.fetchDetails(searchResults.slice(0, 5));

      if (detailed.length === 1) {
        this.log.debug({ path: book.path, title: detailed[0].title }, 'Single result — high confidence');
        return {
          path: book.path,
          confidence: 'high',
          bestMatch: detailed[0],
          alternatives: [],
        };
      }

      // Multiple results — attempt runtime disambiguation via duration
      if (duration && duration > 0) {
        const withDistance = detailed
          .filter(d => d.duration && d.duration > 0)
          .map(d => ({
            meta: d,
            distance: Math.abs(d.duration! - duration!) / duration!,
          }))
          .sort((a, b) => a.distance - b.distance);

        if (withDistance.length > 0) {
          const best = withDistance[0];
          const rest = withDistance.slice(1).map(w => w.meta);
          const othersWithoutDuration = detailed.filter(
            d => !d.duration || d.duration <= 0,
          );

          const confidence: Confidence = best.distance <= DURATION_THRESHOLD ? 'high' : 'medium';
          this.log.debug(
            {
              path: book.path,
              confidence,
              bestTitle: best.meta.title,
              bookDuration: duration,
              matchDuration: best.meta.duration,
              distancePct: `${(best.distance * 100).toFixed(1)}%`,
              candidatesWithDuration: withDistance.length,
              candidatesWithoutDuration: othersWithoutDuration.length,
            },
            'Duration disambiguation result',
          );

          return {
            path: book.path,
            confidence,
            bestMatch: best.meta,
            alternatives: [...rest, ...othersWithoutDuration],
          };
        }
      }

      // No duration data — medium confidence with best guess (first result)
      this.log.debug(
        { path: book.path, resultCount: detailed.length, hasDuration: !!duration },
        'Multiple results, no duration disambiguation — medium confidence',
      );
      return {
        path: book.path,
        confidence: 'medium',
        bestMatch: detailed[0],
        alternatives: detailed.slice(1),
      };
    } catch (error) {
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
        } catch (error) {
          this.log.debug({ error, providerId: result.providerId }, 'Detail fetch failed, using search result');
        }
      }
      detailed.push(result);
    }
    return detailed;
  }
}
