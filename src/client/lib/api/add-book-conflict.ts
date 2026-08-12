// Imported from its defining module, not from the `@/lib/api` barrel: the barrel re-exports this
// file, so importing it back would be a cycle.
import { ApiError } from './client.js';
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
 * The add path's only 409 gate (#2258). `null` means "not a conflict this reader speaks for" — any
 * other status, any non-`ApiError` value — so each surface reads the verdict once and keeps its own
 * state effects. Callers must still test `conflict === 'review'` FIRST: a null discriminator
 * reaching the review arm would silently drop a real ownership claim.
 */
export function readAddBookConflict(error: unknown): AddBookConflictDetails | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  return parseAddBookConflict(error.body);
}

/** The review badge/label text, shared by the toast copy and the Search card's badge. */
export const REVIEW_CONFLICT_LABEL = 'Possible duplicate (review)';

/**
 * The incumbent half of the review wording. A review is the resolver abstaining, so it must never
 * read as an ownership claim; one trim rule for every surface means a blank or whitespace-only
 * incumbent title drops the name rather than quoting nothing.
 */
export function formatReviewIncumbentClause(incumbentTitle: string | null): string {
  return incumbentTitle?.trim()
    ? `may be the same recording as '${incumbentTitle}'`
    : 'may be the same recording as a book already in your library';
}

/** The toast-shaped surfaces' review copy. */
export function formatReviewConflictMessage(incumbentTitle: string | null): string {
  return `${REVIEW_CONFLICT_LABEL}: ${formatReviewIncumbentClause(incumbentTitle)}`;
}

/** The same clause as a standalone sentence, for surfaces that render the label as a badge. */
export function formatReviewConflictSentence(incumbentTitle: string | null): string {
  const clause = formatReviewIncumbentClause(incumbentTitle);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}
