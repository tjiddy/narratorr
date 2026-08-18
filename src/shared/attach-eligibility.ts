import { bookHoldsFile } from './book-holds-file.js';
import type { BookStatus } from './schemas/book.js';

/** Statuses whose book is a record waiting for a file.
 *
 * `downloading` and `importing` are excluded because a live acquisition already owns the book and
 * an attach would race it; `imported` because it is already fulfilled. The staged classifier, the
 * book-scoped route and the client menu gate all key on this one list so the UI cannot offer an
 * action the server refuses. */
export const ATTACHABLE_BOOK_STATUSES = ['wanted', 'searching', 'failed', 'missing'] as const;

export type AttachableBookStatus = (typeof ATTACHABLE_BOOK_STATUSES)[number];

export function isAttachableStatus(status: BookStatus | string): status is AttachableBookStatus {
  return (ATTACHABLE_BOOK_STATUSES as readonly string[]).includes(status);
}

/** The two conditions every attach surface enforces, in one place. */
export function canAttachFile(book: { path?: string | null | undefined; status: BookStatus | string }): boolean {
  return !bookHoldsFile(book.path) && isAttachableStatus(book.status);
}
