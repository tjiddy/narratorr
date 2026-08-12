import { addBookConflictSchema, type AddBookConflict } from '@shared/schemas/book.js';

/** The POST /api/books 409 body reduced to what the add surfaces switch on (#2199). */
export interface AddBookConflictDetails {
  /** null when the discriminator is absent or unrecognized — degrade to the plain ownership claim. */
  conflict: AddBookConflict | null;
  incumbentId: number | null;
  incumbentTitle: string | null;
}

/**
 * The body is the incumbent row with the discriminator riding on top, so `id`/`title` read the same
 * as they did before #2199 and an older server simply reports no conflict.
 */
export function parseAddBookConflict(body: unknown): AddBookConflictDetails {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const conflict = addBookConflictSchema.safeParse(b.conflict);
  return {
    conflict: conflict.success ? conflict.data : null,
    incumbentId: typeof b.id === 'number' ? b.id : null,
    incumbentTitle: typeof b.title === 'string' ? b.title : null,
  };
}

/**
 * The toast-shaped surfaces' shared review copy. A review is the resolver abstaining, so the wording
 * must never read as an ownership claim; a blank incumbent title drops the name rather than quoting
 * nothing.
 */
export function formatReviewConflictMessage(incumbentTitle: string | null): string {
  return incumbentTitle?.trim()
    ? `Possible duplicate (review): may be the same recording as '${incumbentTitle}'`
    : 'Possible duplicate (review): may be the same recording as a book already in your library';
}
