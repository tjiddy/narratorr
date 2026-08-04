import type { MergeActivePhase, MergeStateSnapshot } from '@shared/schemas/sse-events.js';

/**
 * In-memory mirror of the live merge domain, broadcast as the `merge_state` snapshot (#2129).
 *
 * It is a *separate* container from `MergeService`'s `inProgress` / `queue` / `currentPhase`
 * maps on purpose: those are cleared by `finally` blocks that run AFTER the terminal event is
 * emitted, and a snapshot that still contained a terminal book would overwrite the terminal
 * card the client just installed. This state has its own lifecycle — install at admission,
 * update on progress, delete BEFORE the terminal emit — with the service's existing `finally`
 * cleanups acting only as an idempotent backstop for the paths that end with no terminal event.
 *
 * Everything here is synchronous and in-memory: {@link snapshot} is called from the SSE route
 * on the same tick the client registers, so it can never await a DB read (a suspension there
 * would let a newer state change land first and be overwritten by the stale greeting).
 *
 * Titles are captured at the points that already load the book (enqueue validation, promotion)
 * so a late joiner learning about a queued book *only* from the connect greeting still gets a
 * title to render.
 */
export class MergeStateTracker {
  private activeEntries = new Map<number, { title: string; phase: MergeActivePhase; percentage?: number }>();
  /** Insertion-ordered, mirroring `MergeService.queue` — the snapshot's FIFO order. */
  private queuedTitles = new Map<number, string>();

  /** The book was appended to the merge queue. */
  markQueued(bookId: number, bookTitle: string): void {
    this.activeEntries.delete(bookId);
    this.queuedTitles.set(bookId, bookTitle);
  }

  /**
   * Admission: the book was handed a semaphore slot. Leaving the queue and entering `active`
   * is ONE transition (the caller broadcasts a single frame), so a promoted book never appears
   * in both lists — nor, between two frames, in neither.
   */
  markActive(bookId: number, bookTitle: string): void {
    this.queuedTitles.delete(bookId);
    this.activeEntries.set(bookId, { title: bookTitle, phase: 'starting' });
  }

  /**
   * Phase / percentage update for an in-flight merge. `percentage` mirrors the last
   * `merge_progress` emit exactly — including an emit that carries none (a phase transition),
   * which clears it, matching what the incremental events used to do to the client store.
   * A no-op for a book with no active entry.
   */
  updateProgress(bookId: number, phase: MergeActivePhase, percentage?: number): void {
    const entry = this.activeEntries.get(bookId);
    if (!entry) return;
    entry.phase = phase;
    if (percentage === undefined) delete entry.percentage;
    else entry.percentage = percentage;
  }

  /**
   * Drop the book from the snapshot. Returns whether anything was actually removed, which is
   * what lets the backstop cleanups stay silent on the normal terminal path (exactly one
   * terminal frame per merge) while still rescuing the no-terminal-event exits.
   */
  remove(bookId: number): boolean {
    const wasActive = this.activeEntries.delete(bookId);
    const wasQueued = this.queuedTitles.delete(bookId);
    return wasActive || wasQueued;
  }

  /**
   * The title captured when the book entered the snapshot, so a terminal emitter can take it
   * as a parameter instead of re-reading the book (which would put an `await` inside the
   * delete → terminal event → cleared snapshot sequence).
   */
  titleFor(bookId: number): string | undefined {
    return this.activeEntries.get(bookId)?.title ?? this.queuedTitles.get(bookId);
  }

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
}
