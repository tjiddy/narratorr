import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { BookService } from './book.service.js';
import type { BookMetadata } from '@core/metadata/index.js';
import type { MatchCandidate, MatchResult, MatchJobStatus } from './match-job.types.js';
import { scanAudioDirectory, type AudioScanResult } from '@core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import type { SettingsService } from './settings.service.js';
import { BoundedSemaphore } from '@core/utils/bounded-semaphore.js';
import { diceCoefficient } from '@core/utils/similarity.js';
import { searchWithSwapRetryTrace } from '../utils/search-helpers.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { applyLibraryDuplicate, applyNarratorCap, deriveTagQuery, isDurationVerified, rankResults, rankResultsCleaned, resolveConfidenceFromDuration, resolveSingleResultConfidence, tagPassPredicatesPass, TITLE_SIMILARITY_FLOOR, type ChapterRuntimeSeconds, type DurationConfidenceResult, type NarratorCapContext, type TagQuery } from './match-job.helpers.js';
import { planTagSearchAttempts, type TagSearchAttempt, type TagSearchOutcome } from './tag-search-planner.js';
import { corroborateDurationVerdict, type CorroboratedDuration } from './chapter-corroboration.js';
import { runAsinIdentificationRung } from './match-asin-rung.js';
import { assembleMatchOutcome } from './match-outcome-assembly.js';


// Preserve public type imports after the contracts moved to match-job.types.ts.
export type { Confidence, MatchCandidate, MatchResult, MatchJobStatus } from './match-job.types.js';

const MAX_CONCURRENCY = 5;
const TTL_MS = 10 * 60 * 1000; // Ten minutes after terminal state.

// Preserve the public capConfidence export after its move to match-job.helpers.ts.
export { capConfidence } from './match-job.helpers.js';

export class MatchJobService {
  private jobs = new Map<string, MatchJob>();

  constructor(
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
    private settingsService: SettingsService,
    private bookService: BookService,
  ) {}

  createJob(books: MatchCandidate[]): string {
    const id = randomUUID();
    const job = new MatchJob(id, books, this.metadataService, this.log, this.settingsService, this.bookService, () => {
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
    const cancelled = job.cancel();
    if (cancelled) this.log.info({ jobId }, 'Match job cancelled');
    return cancelled;
  }

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
  // First terminal event wins, preventing late overwrites and duplicate cleanup scheduling.
  private terminal: 'completed' | 'failed' | 'cancelled' | null = null;
  private error?: string;
  private startMs = Date.now();
  private semaphore = new BoundedSemaphore(MAX_CONCURRENCY);

  private get isCancelled(): boolean {
    return this.terminal === 'cancelled';
  }

  constructor(
    private id: string,
    private books: MatchCandidate[],
    private metadataService: MetadataService,
    private log: FastifyBaseLogger,
    _settingsService: SettingsService,
    private bookService: BookService,
    private onComplete: () => void,
  ) {}

  private async resolveFfprobePath(): Promise<string | undefined> {
    return resolveFfprobePathFromSettings(await resolveFfmpegPath());
  }

  getStatus(): MatchJobStatus {
    return {
      id: this.id,
      status: this.terminal ?? 'matching',
      total: this.books.length,
      matched: this.results.length,
      results: [...this.results],
      ...(this.error !== undefined && { error: this.error }),
    };
  }

  // The winning transition alone owns the TTL cleanup schedule.
  private terminalize(state: 'completed' | 'failed' | 'cancelled', error?: string): boolean {
    if (this.terminal) return false;
    this.terminal = state;
    if (error !== undefined) this.error = error;
    this.onComplete();
    return true;
  }

  cancel(): boolean {
    return this.terminalize('cancelled');
  }

  start(): void {
    // run handles known crashes; unconditional completion no-ops after failure/cancel, and catch is a rejection backstop.
    this.run()
      .then(() => { this.terminalize('completed'); })
      .catch((error: unknown) => {
        this.log.error({ error: serializeError(error), jobId: this.id }, 'Match job failed unexpectedly');
        this.terminalize('failed', getErrorMessage(error));
      });
  }

  private async run(): Promise<void> {
    const promises = this.books.map(book => this.matchWithSemaphore(book));
    try {
      await Promise.allSettled(promises);
    } catch (error: unknown) {
      // Retain partial results but terminalize an orchestration crash so polling cannot stick at matching.
      this.log.error({ error: serializeError(error), jobId: this.id }, 'Match job failed unexpectedly');
      this.terminalize('failed', getErrorMessage(error));
      return;
    }

    this.log.info(
      {
        jobId: this.id,
        total: this.books.length,
        matched: this.results.filter(r => r.confidence !== 'none').length,
        cancelled: this.isCancelled,
        elapsedMs: Date.now() - this.startMs,
      },
      'Match job finished',
    );
  }

  private async matchWithSemaphore(book: MatchCandidate): Promise<void> {
    if (this.isCancelled) return;
    const release = await this.semaphore.acquire();
    try {
      if (this.isCancelled) return;
      const result = await this.matchSingleBook(book);
      this.results.push(result);
    } finally {
      release();
    }
  }

  // eslint-disable-next-line complexity -- audio-scan + tag-pass + filename-pass + scoring branches with conditional-spread on MatchResult
  async matchSingleBook(book: MatchCandidate): Promise<MatchResult> {
    // Preserve raw scan seconds on every exit, including none, title-floor, and error results.
    let scannedSeconds: number | undefined;
    const withScanned = (result: MatchResult): MatchResult =>
      scannedSeconds && scannedSeconds > 0 ? { ...result, scannedSeconds } : result;
    try {
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
          // Audible runtimes are minutes; retain raw seconds separately for comparisons.
          duration = Math.round(audioResult.totalDuration / 60);
          scannedSeconds = audioResult.totalDuration;
          this.log.debug({ path: book.path, duration: `${duration}min` }, 'Audio duration scanned');
        }
      } catch (error: unknown) {
        this.log.debug({ error: serializeError(error), path: book.path }, 'Audio scan failed — proceeding without duration');
      }

      // High-producing paths converge on one narrator-cap exit; early non-high returns bypass it.
      let resolved: MatchResult, capCtx: NarratorCapContext;

      // An exact ASIN the book already carries outranks any text query, so it runs first.
      const asinOutcome = await runAsinIdentificationRung(
        { metadataService: this.metadataService, log: this.log },
        book.path,
        audioResult?.tagAsin,
      );

      // Tag title and albumartist are structurally distinct, so this pass never swaps them on zero results.
      const tagMatch = asinOutcome
        ? await this.assemble(book.path, audioResult, asinOutcome)
        : await this.tryTagDerivedMatch(book, audioResult);
      if (tagMatch) {
        ({ result: resolved, ctx: capCtx } = tagMatch);
      } else {
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
          return withScanned({ path: book.path, confidence: 'none', bestMatch: null, alternatives: [] });
        }

        this.log.debug({ path: book.path, resultCount: trace.results.length, swapRetry: trace.swapRetry }, 'Search returned results');

        const context: MatchCandidate = trace.swapRetry && book.author
          ? { ...book, title: book.author, author: book.title }
          : book;

        const detailed = await this.fetchDetails(trace.results);

        // Preserve position → duration → year tiebreakers; raw seconds disambiguate tied editions when available.
        const scored = rankResults(detailed, context, audioResult?.totalDuration);
        const topScored = scored[0];
        if (!topScored) {
          // Cancellation can leave scored empty after non-empty search results; return none instead of reading topScored.
          this.log.debug(
            { path: book.path, cancelled: this.isCancelled, resultCount: trace.results.length },
            'No scored results after ranking — cancelled mid-flight or all filtered',
          );
          return withScanned({ path: book.path, confidence: 'none', bestMatch: null, alternatives: [] });
        }

        const titleSimilarity = context.title && topScored.meta.title
          ? diceCoefficient(topScored.meta.title, context.title)
          : 0;
        if (titleSimilarity < TITLE_SIMILARITY_FLOOR) {
          this.log.debug(
            { path: book.path, titleSimilarity: titleSimilarity.toFixed(2), bestTitle: topScored.meta.title },
            'Top result below title similarity floor — none confidence',
          );
          return withScanned({
            path: book.path,
            confidence: 'none',
            bestMatch: topScored.meta,
            alternatives: scored.slice(1).map(s => s.meta),
          });
        }

        const scanned = audioResult?.totalDuration;
        if (scored.length === 1) {
          // A mismatch demotes; missing runtime stays high but unverified. Compare unrounded seconds.
          const { verdict, chapterRuntimes } = await this.corroborateDuration(
            book, topScored.meta,
            resolveSingleResultConfidence(topScored.meta, scanned),
            refs => resolveSingleResultConfidence(topScored.meta, scanned, refs),
          );
          resolved = { path: book.path, bestMatch: topScored.meta, alternatives: [], ...verdict };
          // Verify against the same full/trimmed references that produced the promoted verdict.
          capCtx = { log: this.log, matchSource: 'filename-single', durationVerified: isDurationVerified(topScored.meta, scanned, chapterRuntimes) };
        } else {
          // Ranking already chose the winner; runtime agreement now determines its confidence.
          const { verdict } = await this.corroborateDuration(
            book, topScored.meta,
            resolveConfidenceFromDuration(scored, scanned),
            refs => resolveConfidenceFromDuration(scored, scanned, refs),
          );
          const { confidence, reason, reasonKind } = verdict;
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
          resolved = {
            path: book.path,
            confidence,
            bestMatch: topScored.meta,
            alternatives: scored.slice(1).map(s => s.meta),
            ...(reason !== undefined && { reason }),
            ...(reasonKind !== undefined && { reasonKind }),
          };
          // Here, high is possible only through duration corroboration.
          capCtx = { log: this.log, matchSource: 'filename-duration-resolved', durationVerified: confidence === 'high' };
        }
      }

      const capped = applyNarratorCap(resolved, audioResult, capCtx);

      // Detect library duplicates from resolved metadata, not the filename candidate.
      return withScanned(await applyLibraryDuplicate(capped, this.bookService, this.log));
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error), path: book.path, title: book.title }, 'Match failed for book');
      return withScanned({
        path: book.path,
        confidence: 'none',
        bestMatch: null,
        alternatives: [],
        error: getErrorMessage(error),
      });
    }
  }

  // Corroborate before the narrator wrong-edition cap; caching and throttling live downstream.
  private corroborateDuration(
    book: MatchCandidate,
    meta: BookMetadata,
    verdict: DurationConfidenceResult,
    recheck: (chapterRuntimes: ChapterRuntimeSeconds) => DurationConfidenceResult,
  ): Promise<CorroboratedDuration> {
    return corroborateDurationVerdict({
      verdict,
      asin: meta.asin,
      path: book.path,
      log: this.log,
      lookupChapterSeconds: asin => this.metadataService.getChapterRuntimeSeconds(asin),
      recheck,
    });
  }

  // Any tag-path miss returns null so the caller falls through to filename matching.
  private async tryTagDerivedMatch(
    book: MatchCandidate,
    audioResult: AudioScanResult | null,
  ): Promise<{ result: MatchResult; ctx: NarratorCapContext } | null> {
    const tagQuery = deriveTagQuery(audioResult);
    if (!tagQuery || !audioResult) return null;
    this.log.debug({ path: book.path, tagTitle: tagQuery.title, tagAuthor: tagQuery.author }, 'Tag-derived metadata search');
    const outcome = await this.runTagSearch(book, audioResult, tagQuery);
    if (!outcome) return null;
    return this.assemble(book.path, audioResult, outcome);
  }

  private assemble(
    path: string,
    audioResult: AudioScanResult | null,
    outcome: TagSearchOutcome,
  ): Promise<{ result: MatchResult; ctx: NarratorCapContext }> {
    return assembleMatchOutcome(
      { log: this.log, lookupChapterSeconds: asin => this.metadataService.getChapterRuntimeSeconds(asin) },
      path,
      audioResult,
      outcome,
    );
  }

  // Each planned search → detail → rank → predicate attempt; the ASIN sources already ran.
  private async runTagSearch(
    book: MatchCandidate,
    audioResult: AudioScanResult,
    tagQuery: TagQuery,
  ): Promise<TagSearchOutcome | null> {
    const attempts = planTagSearchAttempts(audioResult, tagQuery);
    for (const attempt of attempts) {
      // A non-null tag scan uses 0 as no-signal while preserving the edition-tiebreaker API.
      const outcome = await this.tryAttempt(book, tagQuery, attempt, audioResult.totalDuration);
      if (outcome) return outcome;
    }
    this.log.debug(
      { path: book.path, tagTitle: tagQuery.title, attemptCount: attempts.length },
      'Tag-search planner exhausted all attempts — falling through',
    );
    return null;
  }

  private async tryAttempt(
    book: MatchCandidate,
    tagQuery: TagQuery,
    attempt: TagSearchAttempt,
    scannedSeconds: number,
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

    // Rebuild the attempt query without dropping series position 0.
    const attemptQuery: TagQuery = { title: attempt.title, author: attempt.author, ...(tagQuery.year ? { year: tagQuery.year } : {}), ...(tagQuery.seriesPosition !== undefined && { seriesPosition: tagQuery.seriesPosition }) };
    const scored = rankResultsCleaned(detailed, attemptQuery, scannedSeconds);
    const top = scored[0];
    if (!top) return null;

    if (!tagPassPredicatesPass(this.log, book.path, attemptQuery, top)) return null;

    this.log.debug(
      { path: book.path, source: attempt.source, originalTagTitle: tagQuery.title, attemptTitle: attempt.title, bestTitle: top.meta.title },
      'Tag-search attempt won',
    );
    return { scored, attempt };
  }

  private async fetchDetails(results: BookMetadata[]): Promise<BookMetadata[]> {
    const detailed: BookMetadata[] = [];
    for (const result of results) {
      if (this.isCancelled) break;
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

