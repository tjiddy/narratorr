import type { MatchCandidate, MatchJobStatus, MatchResult } from '@/lib/api';
import { packMatchCandidates } from './match-packing.js';
import { matchSetTimeout, matchClearTimeout } from './match-timer.js';
import {
  classifyPollError,
  MATCH_POLL_INTERVAL_MS,
  MATCH_RETRY_BACKOFF_MS,
  MATCH_RETRY_LIMIT,
  type PausedReason,
} from './match-recovery.js';

export interface MatchApi {
  startMatchJob: (candidates: MatchCandidate[]) => Promise<{ jobId: string }>;
  getMatchJob: (jobId: string) => Promise<MatchJobStatus>;
  cancelMatchJob: (jobId: string) => Promise<unknown>;
}

export interface MatchEngineSnapshot {
  results: MatchResult[];
  progress: { matched: number; total: number };
  isMatching: boolean;
  recovering: boolean;
  paused: boolean;
  reason: PausedReason | null;
  remaining: number;
  matchedCount: number;
  total: number;
}

/** Only `auto-initial` may spend the automatic allowance; remainder phases are already in-attempt. */
type RunPhase = 'auto-initial' | 'auto-remainder' | 'human-remainder';

/** Entry probes may authorize one remainder; `in-attempt` never replaces the job. */
type ProbeContext = 'automatic-entry' | 'resume-entry' | 'in-attempt';

/**
 * One logical run spans chunks and remainders. A serialized timer loop plus epoch guards
 * permits one status request in flight; the path-keyed observed map owns remainder state (#1864).
 */
export class MatchEngine {
  private epoch = 0;
  private disposed = false;
  private jobId: string | null = null;
  private observed = new Map<string, MatchResult>();
  private original: MatchCandidate[] = [];
  private chunks: MatchCandidate[][] = [];
  private chunkIndex = 0;
  /** Baseline before oversized ingestion; compare original-set remainder, not off-domain-capable map size. */
  private runEntryRemaining = 0;
  private phase: RunPhase = 'auto-initial';
  private allowanceSpent = false;
  private hasPaused = false;
  private failureCount = 0;
  private isMatching = false;
  /** Marks human or automatic remainder runs so the fail-closed CTA stays locked (F1). */
  private recoveryRun = false;
  private paused: PausedReason | null = null;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: MatchApi, private onChange: (snap: MatchEngineSnapshot) => void) {}

  /** Initial scan-to-match run; resets the logical allowance. */
  startMatching(candidates: MatchCandidate[]): void {
    this.beginLogical(candidates, false);
  }

  /** New logical run over current row values, entered through the recovery CTA. */
  restart(candidates: MatchCandidate[]): void {
    this.beginLogical(candidates, true);
  }

  /** One authorized remainder attempt; probe first when an id survives. */
  resume(): void {
    if (!this.paused) return;
    this.epoch += 1;
    this.clearPoll();
    this.failureCount = 0;
    this.recoveryRun = true;
    this.paused = null;
    this.isMatching = true;
    this.emit();
    if (this.jobId) {
      void this.probe('resume-entry');
    } else {
      // A failed start leaves no job to probe; begin the observed remainder directly.
      this.beginRun(this.remaining(), 'human-remainder');
    }
  }

  cancel(): void {
    this.epoch += 1;
    this.clearPoll();
    this.abandonActiveJob();
    this.isMatching = false;
    this.recoveryRun = false;
    this.paused = null;
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.clearPoll();
    this.abandonActiveJob();
  }

  private beginLogical(candidates: MatchCandidate[], recover: boolean): void {
    this.epoch += 1;
    this.clearPoll();
    this.abandonActiveJob();
    // Path is the run identity; dedupe or one result can satisfy multiple candidates while total disagrees (F2).
    const deduped = dedupeByPath(candidates);
    this.original = deduped;
    this.observed = new Map();
    this.chunkIndex = 0;
    this.allowanceSpent = false;
    this.hasPaused = false;
    this.failureCount = 0;
    this.jobId = null;
    this.paused = null;
    this.recoveryRun = recover;
    this.beginRun(deduped, 'auto-initial');
  }

  private beginRun(candidates: MatchCandidate[], phase: RunPhase): void {
    this.phase = phase;
    // Every chunk/remainder run gets a fresh retry budget; never carry exhaustion into new work (F9).
    this.failureCount = 0;
    // Capture before oversized ejection so that removal counts as forward progress (F4).
    this.runEntryRemaining = this.remaining().length;
    const { chunks, oversized } = packMatchCandidates(candidates);
    // A too-large candidate becomes unmatchable `none`; never send it or leave it in the remainder (F15).
    for (const candidate of oversized) this.ingestOversized(candidate);
    this.chunks = chunks;
    this.chunkIndex = 0;
    this.paused = null;
    if (this.chunks.length === 0) {
      this.finishLogical();
      return;
    }
    this.isMatching = true;
    this.emit();
    this.startNextChunk();
  }

  private ingestOversized(candidate: MatchCandidate): void {
    this.observed.set(candidate.path, {
      path: candidate.path,
      confidence: 'none',
      bestMatch: null,
      alternatives: [],
      error: 'Candidate too large to match',
    });
  }

  private startNextChunk(): void {
    if (this.disposed) return;
    if (this.chunkIndex >= this.chunks.length) {
      this.startRemainderOrFinish(this.phase);
      return;
    }
    void this.startChunk(this.chunks[this.chunkIndex]!, this.epoch);
  }

  private async startChunk(chunk: MatchCandidate[], epoch: number): Promise<void> {
    try {
      const { jobId } = await this.api.startMatchJob(chunk);
      if (this.epoch !== epoch) {
        this.api.cancelMatchJob(jobId).catch(() => {});
        return;
      }
      this.jobId = jobId;
      this.schedulePoll(MATCH_POLL_INTERVAL_MS);
    } catch {
      if (this.epoch !== epoch) return;
      // Never retry a start POST: a lost response may hide a created job and duplicate the chunk (§4/F14).
      this.pause('start-failed');
    }
  }

  private startRemainderOrFinish(phase: RunPhase): void {
    const remaining = this.remaining();
    if (remaining.length === 0) {
      this.finishLogical();
      return;
    }
    // An unchanged original-set remainder means `completed` omitted work; pause instead of looping (#1870).
    if (remaining.length >= this.runEntryRemaining) {
      this.pause('run-expired');
      return;
    }
    this.jobId = null;
    this.beginRun(remaining, phase);
  }

  private finishLogical(): void {
    this.jobId = null;
    this.isMatching = false;
    this.recoveryRun = false;
    this.paused = null;
    this.emit();
  }

  private schedulePoll(delay: number): void {
    this.clearPoll();
    this.pollHandle = matchSetTimeout(() => { void this.poll(); }, delay);
  }

  private clearPoll(): void {
    if (this.pollHandle) {
      matchClearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private async poll(): Promise<void> {
    this.pollHandle = null;
    const epoch = this.epoch;
    const jobId = this.jobId;
    if (this.disposed || !jobId) return;
    try {
      const status = await this.api.getMatchJob(jobId);
      if (this.epoch !== epoch || status.id !== this.jobId) return;
      this.handleStatus(status);
    } catch (error: unknown) {
      if (this.epoch !== epoch) return;
      this.handlePollError(error);
    }
  }

  private handleStatus(status: MatchJobStatus): void {
    this.failureCount = 0; // Any successful poll resets the retry budget (§1).
    this.ingest(status);
    if (status.status === 'matching') {
      this.schedulePoll(MATCH_POLL_INTERVAL_MS);
      return;
    }
    if (status.status === 'completed') {
      this.jobId = null;
      this.chunkIndex += 1;
      this.startNextChunk();
      return;
    }
    if (status.status === 'cancelled') {
      this.terminalCancelled(this.runContext());
      return;
    }
    this.terminalGone(this.runContext());
  }

  private handlePollError(error: unknown): void {
    const cls = classifyPollError(error);
    if (cls === 'gone') {
      this.terminalGone(this.runContext());
      return;
    }
    if (cls === 'rejected') {
      this.pause('request-rejected');
      return;
    }
    // Transport/server failures use bounded serialized backoff with state preserved.
    this.failureCount += 1;
    if (this.failureCount <= MATCH_RETRY_LIMIT) {
      // Expose transient backoff through `recovering` so the fail-closed CTA locks (F1).
      this.emit();
      this.schedulePoll(MATCH_RETRY_BACKOFF_MS);
      return;
    }
    void this.probe(this.runContext()); // Exhaustion requires a probe before replacement (§1→§3).
  }

  private async probe(context: ProbeContext): Promise<void> {
    const epoch = this.epoch;
    const jobId = this.jobId;
    if (this.disposed || !jobId) return;
    try {
      const status = await this.api.getMatchJob(jobId);
      if (this.epoch !== epoch || status.id !== this.jobId) return;
      this.applyProbeOutcome(status, context);
    } catch (error: unknown) {
      if (this.epoch !== epoch) return;
      const cls = classifyPollError(error);
      if (cls === 'gone') this.terminalGone(context);
      else if (cls === 'rejected') this.pause('request-rejected');
      else this.pause('unreachable'); // Inconclusive transport/5xx retains the id; never replace blindly.
    }
  }

  private applyProbeOutcome(status: MatchJobStatus, context: ProbeContext): void {
    if (status.status === 'matching') {
      this.failureCount = 0;
      this.ingest(status);
      this.schedulePoll(MATCH_POLL_INTERVAL_MS);
      return;
    }
    if (status.status === 'completed') {
      this.ingest(status);
      this.jobId = null;
      this.startRemainderOrFinish(this.phase);
      return;
    }
    if (status.status === 'cancelled') {
      this.terminalCancelled(context);
      return;
    }
    this.terminalGone(context);
  }

  private terminalGone(context: ProbeContext): void {
    if (context === 'resume-entry') {
      this.jobId = null;
      this.beginRun(this.remaining(), 'human-remainder');
      return;
    }
    if (context === 'automatic-entry' && !this.allowanceSpent) {
      // Spend the sole automatic allowance before the first pause and lock the recovery CTA (F1).
      this.allowanceSpent = true;
      this.recoveryRun = true;
      this.jobId = null;
      this.beginRun(this.remaining(), 'auto-remainder');
      return;
    }
    // In-attempt, or automatic-entry after its allowance is spent (F9/F13).
    this.pause('run-expired');
  }

  private terminalCancelled(context: ProbeContext): void {
    if (context === 'resume-entry') {
      // Human authorization permits one fresh remainder after cancellation.
      this.jobId = null;
      this.beginRun(this.remaining(), 'human-remainder');
      return;
    }
    // Automatic/in-attempt cancellation must not resurrect work (#1833).
    this.pause('cancelled');
  }

  private pause(reason: PausedReason): void {
    this.clearPoll();
    if (reason === 'start-failed') this.jobId = null; // No active job exists to probe (§4/F14).
    this.hasPaused = true;
    this.isMatching = false;
    this.paused = reason;
    this.emit();
  }

  /** Recovery includes recovery runs and transient backoff, but excludes paused/idle/healthy initial polling (F1/#1102). */
  private isRecovering(): boolean {
    if (!this.isMatching) return false;
    return this.recoveryRun || this.failureCount > 0;
  }

  private runContext(): ProbeContext {
    return this.phase === 'auto-initial' && !this.hasPaused && !this.allowanceSpent
      ? 'automatic-entry'
      : 'in-attempt';
  }

  private remaining(): MatchCandidate[] {
    return this.original.filter(c => !this.observed.has(c.path));
  }

  private ingest(status: MatchJobStatus): void {
    // Path-keyed queue state, never asynchronous React state, determines the remainder.
    for (const r of status.results) this.observed.set(r.path, r);
    this.emit();
  }

  private abandonActiveJob(): void {
    if (this.jobId) {
      this.api.cancelMatchJob(this.jobId).catch(() => {});
      this.jobId = null;
    }
  }

  private emit(): void {
    if (this.disposed) return;
    this.onChange(this.snapshot());
  }

  private snapshot(): MatchEngineSnapshot {
    return {
      results: [...this.observed.values()],
      progress: { matched: this.observed.size, total: this.original.length },
      isMatching: this.isMatching,
      recovering: this.isRecovering(),
      paused: this.paused !== null,
      reason: this.paused,
      remaining: this.remaining().length,
      matchedCount: this.observed.size,
      total: this.original.length,
    };
  }
}

/** Candidate identity is path; first occurrence wins (F2). */
function dedupeByPath(candidates: MatchCandidate[]): MatchCandidate[] {
  const seen = new Set<string>();
  const out: MatchCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    out.push(candidate);
  }
  return out;
}
