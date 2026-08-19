import type { FastifyBaseLogger } from 'fastify';
import type { MergeActivePhase, MergeStateSnapshot } from '@shared/schemas/sse-events.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';

/**
 * Keep synchronous snapshot state separate from MergeService cleanup maps. Remove terminal state
 * before its event or the following snapshot can overwrite the client's terminal card. Snapshot
 * reads cannot await DB without racing newer state, so titles are captured on admission.
 */
export class MergeStateBroadcaster {
  private activeEntries = new Map<number, { title: string; phase: MergeActivePhase; percentage?: number }>();
  /** Insertion-ordered, mirroring `MergeService.queue` — the snapshot's FIFO order. */
  private queuedTitles = new Map<number, string>();

  constructor(
    private log: FastifyBaseLogger,
    private broadcaster?: EventBroadcasterService,
  ) {}

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

  enterQueued(bookId: number, bookTitle: string): void {
    this.activeEntries.delete(bookId);
    this.queuedTitles.set(bookId, bookTitle);
    this.broadcast();
  }

  /**
   * Promote in one frame so the book never appears in both lists or transiently in neither.
   */
  enterActive(bookId: number, bookTitle: string): void {
    this.queuedTitles.delete(bookId);
    this.activeEntries.set(bookId, { title: bookTitle, phase: 'starting' });
    this.broadcast();
  }

  /**
   * A phase-only update clears stale percentage. Untracked updates emit no unchanged frame.
   */
  updateProgress(bookId: number, phase: MergeActivePhase, percentage?: number): void {
    const entry = this.activeEntries.get(bookId);
    if (!entry) return;
    entry.phase = phase;
    if (percentage === undefined) delete entry.percentage;
    else entry.percentage = percentage;
    this.broadcast();
  }

  /**
   * Atomically remove snapshot state, emit the terminal event, then broadcast the cleared snapshot.
   * Reordering lets stale in-flight state overwrite the terminal card.
   */
  finishTerminal(bookId: number, emitTerminal: () => void): void {
    const removed = this.remove(bookId);
    emitTerminal();
    if (removed) this.broadcast();
  }

  /** Idempotent cleanup for exits with no terminal event; broadcast only on change. */
  clearResidue(bookId: number): void {
    if (this.remove(bookId)) this.broadcast();
  }

  /**
   * "Broadcast as active", the only state a cancellation can key on while the merge owns no
   * AbortController — between promotion and the admission acquisition (#2462).
   */
  isActive(bookId: number): boolean {
    return this.activeEntries.has(bookId);
  }

  /** Avoid a title re-read inside the synchronous terminal sequence. */
  titleFor(bookId: number): string {
    return this.activeEntries.get(bookId)?.title ?? this.queuedTitles.get(bookId) ?? `Book ${bookId}`;
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
