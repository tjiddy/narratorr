import type { MatchCandidate, MatchJobStatus, MatchResult } from '@/lib/api';
import { packMatchCandidates } from './match-packing.js';
import {
  classifyPollError,
  MATCH_POLL_INTERVAL_MS,
  MATCH_RETRY_BACKOFF_MS,
  MATCH_RETRY_LIMIT,
  type PausedReason,
} from './match-recovery.js';

/** The three chunk-job endpoints the engine drives. */
export interface MatchApi {
  startMatchJob: (candidates: MatchCandidate[]) => Promise<{ jobId: string }>;
  getMatchJob: (jobId: string) => Promise<MatchJobStatus>;
  cancelMatchJob: (jobId: string) => Promise<unknown>;
}

/** Immutable snapshot the engine hands to React on every state change. */
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

/**
 * Which phase of a logical run the poll loop is currently driving (§0/§2/§3):
 * - `auto-initial`    — the initial scan / Restart run; its terminal-gone may
 *   consume the one automatic allowance (→ `automatic-entry` probe context).
 * - `auto-remainder`  — the allowance-started remainder; its polls are in-attempt.
 * - `human-remainder` — a Resume-authorized remainder; its polls are in-attempt.
 */
type RunPhase = 'auto-initial' | 'auto-remainder' | 'human-remainder';

/**
 * Probe context (§3). Determines what a terminal-gone / cancelled / inconclusive
 * outcome does. `automatic-entry` may consume the allowance once; `resume-entry`
 * authorizes exactly one remainder; `in-attempt` never starts a new remainder.
 */
type ProbeContext = 'automatic-entry' | 'resume-entry' | 'in-attempt';

/**
 * Framework-agnostic match-phase recovery engine (#1864). One logical run spans
 * all its chunks and any internal remainder; a SINGLE serialized timeout-driven
 * poll/retry/probe loop keeps at most one status request in flight, guarded by a
 * run epoch checked after every await (defense-in-depth over the job-id guard).
 * Observed results are queue-owned in an append-only `Map<path, MatchResult>` — the
 * authoritative source for the remainder, never the async React `results` state.
 */
export class MatchEngine {
  private epoch = 0;
  private disposed = false;
  private jobId: string | null = null;
  private observed = new Map<string, MatchResult>();
  private original: MatchCandidate[] = [];
  private chunks: MatchCandidate[][] = [];
  private chunkIndex = 0;
  private phase: RunPhase = 'auto-initial';
  private allowanceSpent = false;
  private hasPaused = false;
  private failureCount = 0;
  private isMatching = false;
  /**
   * True when the CURRENT logical run is itself a recovery run — a human Restart/Resume,
   * or the automatic allowance-started remainder. Combined with a transient retry backoff
   * (`failureCount > 0`) it derives the exposed `recovering` flag (F1), so the fail-closed
   * CTA stays locked during automatic retry/remainder, not just during a human-driven one.
   */
  private recoveryRun = false;
  private paused: PausedReason | null = null;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: MatchApi, private onChange: (snap: MatchEngineSnapshot) => void) {}

  // ─── Public commands ──────────────────────────────────────────────

  /** Initial automatic run (scan → match). Fresh logical run; allowance reset. */
  startMatching(candidates: MatchCandidate[]): void {
    this.beginLogical(candidates, false);
  }

  /** Restart all — a NEW logical run over current row values; recovery-gated CTA. */
  restart(candidates: MatchCandidate[]): void {
    this.beginLogical(candidates, true);
  }

  /** Resume remaining — one authorized attempt (§2-B). Probe when a job id is known. */
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
      // Start-failure carve-out (§3): no job to probe — start the observed remainder.
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

  // ─── Run / chunk orchestration ────────────────────────────────────

  private beginLogical(candidates: MatchCandidate[], recover: boolean): void {
    this.epoch += 1;
    this.clearPoll();
    this.abandonActiveJob();
    // Candidate paths are the logical-run identity (observed map, remainder, and every
    // status result are keyed by `path`). Duplicate paths would let one result satisfy
    // several candidates and finish with `matched < total` (§0/F2). Collapse to
    // first-occurrence up front so `total` and the remainder stay path-consistent.
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
    this.chunks = packMatchCandidates(candidates);
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
      // NO retry on chunk-start POSTs (§4): the request may have created a job and
      // lost the response — a blind retry double-runs a chunk. A replacement start is
      // issued only after the old terminal id is cleared, so a rejection leaves no
      // active job id (F14); the next Resume takes the start-failure carve-out.
      this.pause('start-failed');
    }
  }

  private startRemainderOrFinish(phase: RunPhase): void {
    const remaining = this.remaining();
    if (remaining.length === 0) {
      this.finishLogical();
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

  // ─── Single-flight poll loop ──────────────────────────────────────

  private schedulePoll(delay: number): void {
    this.clearPoll();
    this.pollHandle = setTimeout(() => { void this.poll(); }, delay);
  }

  private clearPoll(): void {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
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
    this.failureCount = 0; // any successful poll resets the retry counter (§1)
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
    this.terminalGone(this.runContext()); // 'failed'
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
    // transport | server — bounded serialized backoff retry, all state preserved.
    this.failureCount += 1;
    if (this.failureCount <= MATCH_RETRY_LIMIT) {
      // Emit so the derived `recovering` flag (failureCount > 0) reaches consumers and the
      // fail-closed CTA locks during the transient backoff, not only during a human recovery (F1).
      this.emit();
      this.schedulePoll(MATCH_RETRY_BACKOFF_MS);
      return;
    }
    void this.probe(this.runContext()); // exhausted → probe (§1 → §3)
  }

  // ─── Probe before replace (§3) ────────────────────────────────────

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
      else this.pause('unreachable'); // transport/5xx inconclusive — retain id, never replace
    }
  }

  private applyProbeOutcome(status: MatchJobStatus, context: ProbeContext): void {
    if (status.status === 'matching') {
      this.failureCount = 0;
      this.ingest(status);
      this.schedulePoll(MATCH_POLL_INTERVAL_MS); // alive → adopt the live job
      return;
    }
    if (status.status === 'completed') {
      this.ingest(status);
      this.jobId = null;
      this.startRemainderOrFinish(this.phase); // terminal-ok → ingest, advance
      return;
    }
    if (status.status === 'cancelled') {
      this.terminalCancelled(context);
      return;
    }
    this.terminalGone(context); // 'failed'
  }

  // ─── Terminal-gone / cancelled dispositions (§2/§3) ───────────────

  private terminalGone(context: ProbeContext): void {
    if (context === 'resume-entry') {
      this.jobId = null;
      this.beginRun(this.remaining(), 'human-remainder');
      return;
    }
    if (context === 'automatic-entry' && !this.allowanceSpent) {
      // The one automatic allowance — consumed before the first pause only. The
      // allowance-started remainder is itself a recovery run (F1): mark it so the
      // fail-closed CTA stays locked through the automatic remainder.
      this.allowanceSpent = true;
      this.recoveryRun = true;
      this.jobId = null;
      this.beginRun(this.remaining(), 'auto-remainder');
      return;
    }
    // in-attempt, or automatic-entry with the allowance already spent (F9/F13).
    this.pause('run-expired');
  }

  private terminalCancelled(context: ProbeContext): void {
    if (context === 'resume-entry') {
      // Human-authorized: abandon the cancelled job, start a fresh remainder.
      this.jobId = null;
      this.beginRun(this.remaining(), 'human-remainder');
      return;
    }
    // automatic-entry or in-attempt → pause; NO resurrection (#1833).
    this.pause('cancelled');
  }

  private pause(reason: PausedReason): void {
    this.clearPoll();
    if (reason === 'start-failed') this.jobId = null; // no active job to probe (§4/F14)
    this.hasPaused = true;
    this.isMatching = false;
    this.paused = reason;
    this.emit();
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Recovery-in-flight (F1): a recovery run (Restart / Resume / automatic remainder), OR a
   * transient retry backoff in any run. Paused/idle/finished are not "recovering" — the
   * `paused` gate covers the paused case, and healthy initial polling stays unlocked so the
   * selection-scoped CTA still enables importing a matched subset (#1102).
   */
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
    // Queue-owned, append-only merge by `path` — the authoritative source of truth
    // for the remainder, never the async React `results` state (derived-state-over-copied).
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

/** First-occurrence-wins path dedupe — the logical-run identity is the candidate path (F2). */
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
