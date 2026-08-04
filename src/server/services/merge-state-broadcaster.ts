import type { FastifyBaseLogger } from 'fastify';
import type { MergeActivePhase, MergeStateSnapshot } from '@shared/schemas/sse-events.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';

/**
 * The live merge domain, mirrored in memory and broadcast as the `merge_state` snapshot (#2129).
 *
 * It is a *separate* container from `MergeService`'s `inProgress` / `queue` / `currentPhase` maps
 * on purpose: those are cleared by `finally` blocks that run AFTER the terminal event is emitted,
 * and a snapshot that still contained a terminal book would overwrite the terminal card the
 * client just installed. This state has its own lifecycle — install at admission, update on
 * progress, delete BEFORE the terminal emit (see {@link finishTerminal}) — with the service's
 * existing `finally` cleanups acting only as an idempotent backstop for the exits that end a
 * merge with no terminal event at all.
 *
 * Everything here is synchronous and in-memory: {@link snapshot} is called from the SSE route on
 * the same tick the client registers, so it can never await a DB read (a suspension there would
 * let a newer state change land first and be overwritten by the stale greeting). Titles are
 * captured at the points that already load the book (enqueue validation, promotion), because a
 * queued book's snapshot entry is the ONLY title source a late-joining client has for it.
 *
 * Every broadcast goes through `safeEmit`, so a broken broadcaster can never fail a merge.
 */
export class MergeStateBroadcaster {
  private activeEntries = new Map<number, { title: string; phase: MergeActivePhase; percentage?: number }>();
  /** Insertion-ordered, mirroring `MergeService.queue` — the snapshot's FIFO order. */
  private queuedTitles = new Map<number, string>();

  constructor(
    private log: FastifyBaseLogger,
    private broadcaster?: EventBroadcasterService,
  ) {}

  /** Synchronous, allocation-only view of the whole live merge domain. */
  snapshot(): MergeStateSnapshot {
    return {
      active: [...this.activeEntries].map(([bookId, entry]) => ({
        book_id: bookId,
        book_title: entry.title,
        phase: entry.phase,
        ...(entry.percentage !== undefined && { percentage: entry.percentage }),
      })),
      queued: [...this.queuedTitles].map(([bookId, title]) => ({ book_id: bookId, book_title: title })),
    };
  }

  /** The book was appended to the merge queue. */
  enterQueued(bookId: number, bookTitle: string): void {
    this.activeEntries.delete(bookId);
    this.queuedTitles.set(bookId, bookTitle);
    this.broadcast();
  }

  /**
   * Admission: the book was handed a semaphore slot. Leaving the queue and entering `active` is
   * ONE transition and therefore ONE frame, so a promoted book never appears in both lists — nor,
   * between two frames, in neither.
   */
  enterActive(bookId: number, bookTitle: string): void {
    this.queuedTitles.delete(bookId);
    this.activeEntries.set(bookId, { title: bookTitle, phase: 'starting' });
    this.broadcast();
  }

  /**
   * Phase / percentage update for an in-flight merge. `percentage` mirrors the last
   * `merge_progress` emit exactly — including an emit that carries none (a phase transition),
   * which clears it, matching what the incremental events used to do to the client store.
   */
  updateProgress(bookId: number, phase: MergeActivePhase, percentage?: number): void {
    const entry = this.activeEntries.get(bookId);
    if (entry) {
      entry.phase = phase;
      if (percentage === undefined) delete entry.percentage;
      else entry.percentage = percentage;
    }
    this.broadcast();
  }

  /**
   * The terminal transition, in the one authoritative order: (1) drop the book's snapshot state,
   * (2) emit the discrete terminal event, (3) broadcast the snapshot that already excludes it —
   * with no `await` between the three. The client therefore installs the terminal card first and
   * the cleared snapshot second, where its terminal-window exception retains the card.
   * Broadcasting a snapshot that STILL contained the book after its terminal event would
   * overwrite that card with an in-flight entry, cancel its dismiss timer, and let the next
   * snapshot delete it outright.
   *
   * The broadcast is conditional on the delete having removed something, so a path that emits a
   * second terminal event for an already-finished merge adds no extra frame.
   */
  finishTerminal(bookId: number, emitTerminal: () => void): void {
    const removed = this.remove(bookId);
    emitTerminal();
    if (removed) this.broadcast();
  }

  /**
   * Idempotent backstop for the exits that end a merge with NO terminal event — `executeMerge`'s
   * `!book || !book.path` and missing-ffmpeg early returns, and the non-`MergeError` branch of
   * `executeWithRevalidation` — which would otherwise strand a permanent chip. Broadcasts only
   * when it actually removed something, so the normal terminal path stays at exactly one frame.
   */
  clearResidue(bookId: number): void {
    if (this.remove(bookId)) this.broadcast();
  }

  /**
   * The title captured when the book entered the snapshot, so a terminal emitter can take it as a
   * parameter instead of re-reading the book (which would put an `await` inside the delete →
   * terminal event → cleared snapshot sequence).
   */
  titleFor(bookId: number): string | undefined {
    return this.activeEntries.get(bookId)?.title ?? this.queuedTitles.get(bookId);
  }

  private remove(bookId: number): boolean {
    const wasActive = this.activeEntries.delete(bookId);
    const wasQueued = this.queuedTitles.delete(bookId);
    return wasActive || wasQueued;
  }

  private broadcast(): void {
    safeEmit(this.broadcaster, 'merge_state', this.snapshot(), this.log);
  }
}
