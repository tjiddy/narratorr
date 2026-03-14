import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';

/**
 * Revert a book's status based on whether it was previously imported.
 * Books with a filesystem path revert to 'imported'; books without revert to 'wanted'.
 * Returns the computed status so callers can use it for SSE emissions or logging.
 */
export async function revertBookStatus(
  db: Db,
  book: { id: number; path: string | null },
): Promise<'imported' | 'wanted'> {
  const revertStatus = book.path ? 'imported' : 'wanted';
  await db.update(books).set({ status: revertStatus, updatedAt: new Date() }).where(eq(books.id, book.id));
  return revertStatus;
}
