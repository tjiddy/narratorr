import type { FastifyBaseLogger } from 'fastify';
import type { EventSource } from '@shared/schemas/event-history.js';
import { serializeError } from './serialize-error.js';

interface BookSnapshot {
  title: string;
  authors?: Array<{ name: string }> | null;
  narrators?: Array<{ name: string }> | null;
}

export function snapshotBookForEvent(book: BookSnapshot): {
  bookTitle: string;
  authorName: string | null;
  narratorName: string | null;
} {
  return {
    bookTitle: book.title,
    authorName: book.authors?.length ? book.authors.map(a => a.name).join(', ') : null,
    narratorName: book.narrators?.length ? book.narrators.map(n => n.name).join(', ') : null,
  };
}

/**
 * The snapshot-shaped `book_added` payload — all authors joined, narrators joined. Every add
 * surface holding a hydrated row emits exactly this; the bulk surfaces deliberately emit a
 * different shape (primary author plus `reason`, no `narratorName`) and build it themselves.
 */
export function bookAddedSnapshotEvent(book: BookSnapshot & { id: number }, source: EventSource) {
  return {
    bookId: book.id,
    ...snapshotBookForEvent(book),
    eventType: 'book_added' as const,
    source,
  };
}

/**
 * Fire-and-forget by contract: the committed row is the point of no return, so a rejected event
 * write is absorbed here and can never reach a caller's failure path. The message is asserted by
 * several suites — keep it verbatim.
 */
export function announceBookAdded(
  // A thunk, not the recorder plus its event: each caller's `create` is typed to its own event
  // shape, and threading that through a generic resolves it to the bare constraint.
  write: () => Promise<unknown>,
  bookId: number,
  log: FastifyBaseLogger,
): void {
  write().catch((err: unknown) =>
    log.warn({ bookId, error: serializeError(err) }, 'Failed to record book_added event'));
}
