import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { scanAudioDirectory, type AudioScanResult } from '../../core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import type { SettingsService } from './settings.service.js';
import { Semaphore } from '../utils/semaphore.js';
import { diceCoefficient, normalizeNarrator } from '../../core/utils/similarity.js';
import { searchWithSwapRetryTrace } from '../utils/search-helpers.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { deriveTagQuery, rankResults, rankResultsCleaned, resolveConfidenceFromDuration, tagTitleScore, type TagQuery } from './match-job.helpers.js';
import { planTagSearchAttempts, type TagSearchAttempt, type TagSearchOutcome } from './tag-search-planner.js';


export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string | undefined;
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

const MAX_CONCURRENCY = 5;
const TTL_MS = 10 * 60 * 1000; // 10 minutes after completion
const TITLE_SIMILARITY_FLOOR = 0.5; // Below this, confidence is 'none'
const TAG_AUTHOR_PREDICATE_FLOOR = 0.7; // Tag-pass author-name dice threshold (#984)
const CAPPED_ATTEMPT_REASON = 'Low confidence match. Please verify.';

/**
 * Cap a computed Confidence at the planner-attempt's `maxConfidence`. Stripped
 * attempts (album/strip-leading-series/etc.) emit `'medium'` as their cap so
 * downstream Review/Verified UI can flag them for human attention even when
 * the duration check would otherwise bless them as `'high'`.
 */
export function capConfidence(c: Confidence, cap: 'high' | 'medium'): Confidence {
  if (cap === 'medium' && c === 'high') return 'medium';
  return c;
}

// Cap-driven downgrades from a planner attempt need a user-facing tooltip
// reason; without one the amber Review pill renders with no explanation (#1052).
function applyAttemptCap(raw: Confidence, cap: 'high' | 'medium', durationReason: string | undefined): { confidence: Confidence; reason?: string } {
  const confidence = capConfidence(raw, cap);
  const reason = durationReason ?? (confidence === 'medium' ? CAPPED_ATTEMPT_REASON : undefined);
  return reason !== undefined ? { confidence, reason } : { confidence };
}

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

  private async resolveFfprobePath(): Promise<string | undefined> {
    const s = await this.settingsService.get('processing');
    return resolveFfprobePathFromSettings(s?.ffmpegPath);
  }

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
      this.log.error({ error: serializeError(error), jobId: this.id }, 'Match job failed unexpectedly');
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

  // eslint-disable-next-line complexity -- audio-scan + tag-pass + filename-pass + scoring branches with conditional-spread on MatchResult
  async matchSingleBook(book: MatchCandidate): Promise<MatchResult> {
    try {
      // Scan audio files for duration (used for runtime disambiguation) AND tag fields
      let duration: number | undefined;
      let audioResult: AudioScanResult | null = null;
      try {
        const ffprobePath = await this.resolveFfprobePath();
        audioResult = await scanAudioDirectory(book.path, {
          skipCover: true,
          ffprobePath,
          onWarn: (msg, payload) => this.log.warn(payload, msg),
          onDebug: (msg, payload) => this.log.debug(payload, msg),
        });
        if (audioResult && audioResult.totalDuration > 0) {
          // Convert seconds → minutes to match Audible's runtime_length_min
          duration = Math.round(audioResult.totalDuration / 60);
          this.log.debug({ path: book.path, duration: `${duration}min` }, 'Audio duration scanned');
        }
      } catch (error: unknown) {
        this.log.debug({ error: serializeError(error), path: book.path }, 'Audio scan failed — proceeding without duration');
      }

      // Pass 1 — tag-derived search (#984). Fires when both tagTitle and tagAuthor
      // are populated. Bypasses searchWithSwapRetryTrace (no swap-on-zero) because
      // tag.title and tag.albumartist are structurally distinct fields.
      const tagResult = await this.tryTagDerivedMatch(book, audioResult, duration);
      if (tagResult) return tagResult;

      // Pass 2 — filename-derived search via swap-retry wrapper (existing path).
      this.log.debug({ path: book.path, title: book.title, author: book.author, duration }, 'Searching metadata for book');
      const trace = await searchWithSwapRetryTrace({
        searchFn: (q, opts) => this.metadataService.searchBooks(q, opts),
        title: book.title,
        author: book.author,
        log: this.log,
        options: { title: book.title, ...(book.author !== undefined && { author: book.author }) },
      });

      if (trace.results.length === 0) {
        this.log.debug({ path: book.path }, 'No search results returned');
        return { path: book.path, confidence: 'none', bestMatch: null, alternatives: [] };
      }

      this.log.debug({ path: book.path, resultCount: trace.results.length, swapRetry: trace.swapRetry }, 'Search returned results');

      // When swap retry fired and author is present, use swapped context for ranking and similarity
      const context: MatchCandidate = trace.swapRetry && book.author
        ? { ...book, title: book.author, author: book.title }
        : book;

      // Fetch full detail for all results to get ASIN/duration
      const detailed = await this.fetchDetails(trace.results);

      // Score, re-rank, and apply year tiebreaker
      const scored = rankResults(detailed, context);
      const topScored = scored[0];
      if (!topScored) {
        // §6.1 — fetchDetails breaks on this.cancelled, so detailed (and thus
        // scored) can be empty even when trace.results was non-empty. Return
        // a clean 'none' result instead of crashing on topScored.meta.title.
        this.log.debug(
          { path: book.path, cancelled: this.cancelled, resultCount: trace.results.length },
          'No scored results after ranking — cancelled mid-flight or all filtered',
        );
        return { path: book.path, confidence: 'none', bestMatch: null, alternatives: [] };
      }

      // Title similarity floor: below 50% → confidence 'none'
      const titleSimilarity = context.title && topScored.meta.title
        ? diceCoefficient(topScored.meta.title, context.title)
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
        bestMatch: topScored.meta,
        alternatives: scored.slice(1).map(s => s.meta),
        ...(reason !== undefined && { reason }),
      };
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error), path: book.path, title: book.title }, 'Match failed for book');
      return {
        path: book.path,
        confidence: 'none',
        bestMatch: null,
        alternatives: [],
        error: getErrorMessage(error),
      };
    }
  }

  // Pass 1 — tag-derived match (#984, #1036). Returns null on any failure
  // (no tags, zero results across all attempts, floor fail, predicate fail,
  // unexpected throw); caller falls through to filename-derived. Bypasses
  // searchWithSwapRetryTrace — tag.title and tag.albumartist are structurally
  // distinct, no swap-on-zero needed.
  private async tryTagDerivedMatch(
    book: MatchCandidate,
    audioResult: AudioScanResult | null,
    duration: number | undefined,
  ): Promise<MatchResult | null> {
    const tagQuery = deriveTagQuery(audioResult);
    if (!tagQuery || !audioResult) return null;

    this.log.debug({ path: book.path, tagTitle: tagQuery.title, tagAuthor: tagQuery.author }, 'Tag-derived metadata search');

    const outcome = await this.runTagSearch(book, audioResult, tagQuery);
    if (!outcome) return null;

    const { scored, attempt } = outcome;
    const top = scored[0]!;

    if (scored.length === 1) {
      return { path: book.path, ...applyAttemptCap('high', attempt.maxConfidence, undefined), bestMatch: top.meta, alternatives: [] };
    }

    const { confidence, reason } = resolveConfidenceFromDuration(scored, duration);
    return { path: book.path, ...applyAttemptCap(confidence, attempt.maxConfidence, reason), bestMatch: top.meta, alternatives: scored.slice(1).map(s => s.meta) };
  }

  /**
   * Tag-pass search. Runs an ASIN kill-shot when available, otherwise loops
   * planner attempts (search → fetchDetails → rank → predicate). Returns the
   * first attempt that passes predicates; null when all attempts exhaust.
   */
  private async runTagSearch(
    book: MatchCandidate,
    audioResult: AudioScanResult,
    tagQuery: TagQuery,
  ): Promise<TagSearchOutcome | null> {
    if (audioResult.tagAsin) {
      const asinHit = await this.tryAsinKillShot(book, audioResult.tagAsin, tagQuery);
      if (asinHit) return asinHit;
    }

    const attempts = planTagSearchAttempts(audioResult, tagQuery);
    for (const attempt of attempts) {
      const outcome = await this.tryAttempt(book, tagQuery, attempt);
      if (outcome) return outcome;
    }
    this.log.debug(
      { path: book.path, tagTitle: tagQuery.title, attemptCount: attempts.length },
      'Tag-search planner exhausted all attempts — falling through',
    );
    return null;
  }

  /** ASIN kill-shot. Returns outcome when getBook succeeds; null on miss/throw. */
  private async tryAsinKillShot(
    book: MatchCandidate,
    tagAsin: string,
    tagQuery: TagQuery,
  ): Promise<TagSearchOutcome | null> {
    try {
      const found = await this.metadataService.getBook(tagAsin);
      if (found) {
        this.log.debug({ path: book.path, tagAsin, title: found.title }, 'Tag-search ASIN kill-shot hit');
        return {
          scored: [{ meta: found, score: 1.0 }],
          attempt: { title: found.title ?? tagQuery.title, author: tagQuery.author, source: 'asin-tag', maxConfidence: 'high' },
        };
      }
    } catch (error: unknown) {
      this.log.warn(
        { error: serializeError(error), path: book.path, tagAsin },
        'tag-search provider error — falling through to filename-derived path',
      );
    }
    return null;
  }

  /** One planner attempt: search → fetchDetails → rank → predicate. Returns outcome or null. */
  private async tryAttempt(
    book: MatchCandidate,
    tagQuery: TagQuery,
    attempt: TagSearchAttempt,
  ): Promise<TagSearchOutcome | null> {
    let candidates: BookMetadata[];
    try {
      candidates = await this.metadataService.searchBooks(`${attempt.title} ${attempt.author}`, {
        title: attempt.title,
        author: attempt.author,
      });
    } catch (error: unknown) {
      this.log.warn(
        { error: serializeError(error), path: book.path, tagTitle: attempt.title, tagAuthor: attempt.author, attemptSource: attempt.source },
        'tag-search provider error — falling through to filename-derived path',
      );
      return null;
    }
    this.log.debug(
      { path: book.path, tagTitle: attempt.title, tagAuthor: attempt.author, source: attempt.source, candidateCount: candidates.length },
      'Tag-search attempt fired',
    );
    if (candidates.length === 0) return null;

    const detailed = await this.fetchDetails(candidates);
    if (detailed.length === 0) return null;

    const attemptQuery: TagQuery = { title: attempt.title, author: attempt.author, ...(tagQuery.year ? { year: tagQuery.year } : {}) };
    const scored = rankResultsCleaned(detailed, attemptQuery);
    const top = scored[0];
    if (!top) return null;

    if (!this.tagPassPredicatesPass(book, attemptQuery, top)) return null;

    this.log.debug(
      { path: book.path, source: attempt.source, originalTagTitle: tagQuery.title, attemptTitle: attempt.title, bestTitle: top.meta.title },
      'Tag-search attempt won',
    );
    return { scored, attempt };
  }

  /** AC5 — title floor + author predicate gate for the tag pass. Logs at debug on failure. */
  private tagPassPredicatesPass(
    book: MatchCandidate,
    tagQuery: TagQuery,
    top: { meta: BookMetadata; score: number },
  ): boolean {
    const titleFloor = tagTitleScore(tagQuery.title, top.meta);
    if (titleFloor < TITLE_SIMILARITY_FLOOR) {
      this.log.debug(
        { path: book.path, titleSimilarity: titleFloor.toFixed(2), bestTitle: top.meta.title },
        'Tag-derived top result below title floor — falling through',
      );
      return false;
    }
    const topAuthor = top.meta.authors?.[0]?.name;
    const authorScore = topAuthor
      ? diceCoefficient(normalizeNarrator(topAuthor), normalizeNarrator(tagQuery.author))
      : 0;
    if (authorScore < TAG_AUTHOR_PREDICATE_FLOOR) {
      this.log.debug(
        { path: book.path, topResultAuthor: topAuthor, tagAuthor: tagQuery.author, score: authorScore.toFixed(2) },
        'tag-author predicate failed — falling through to filename-derived path',
      );
      return false;
    }
    return true;
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
          this.log.debug({ error: serializeError(error), providerId: result.providerId }, 'Detail fetch failed, using search result');
        }
      }
      detailed.push(result);
    }
    return detailed;
  }
}

