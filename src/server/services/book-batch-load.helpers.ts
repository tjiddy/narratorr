import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { authors, narrators, bookAuthors, bookNarrators } from '../../db/schema.js';
import { chunkArray } from '../utils/batch.js';
import type { BookRow } from './types.js';
import type { BookWithAuthor } from './book.service.js';

type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

/** Batch-load authors and narrators for a list of book rows. Author and narrator
 *  lookups are chunked in batches of 900 IDs to stay under SQLite's 999 bind-param limit. */
export async function batchLoadAuthorsNarrators(db: Db, bookRows: BookRow[]): Promise<BookWithAuthor[]> {
  if (bookRows.length === 0) return [];

  const bookIds = bookRows.map((r) => r.id);

  const authorResults: Array<{ bookId: number; author: AuthorRow; position: number }> = [];
  for (const chunk of chunkArray(bookIds, 900)) {
    const rows = await db
      .select({ bookId: bookAuthors.bookId, author: authors, position: bookAuthors.position })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(inArray(bookAuthors.bookId, chunk));
    authorResults.push(...rows);
  }

  const narratorResults: Array<{ bookId: number; narrator: NarratorRow; position: number }> = [];
  for (const chunk of chunkArray(bookIds, 900)) {
    const rows = await db
      .select({ bookId: bookNarrators.bookId, narrator: narrators, position: bookNarrators.position })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(inArray(bookNarrators.bookId, chunk));
    narratorResults.push(...rows);
  }

  const authorsMap = new Map<number, Array<{ author: AuthorRow; position: number }>>();
  for (const r of authorResults) {
    if (!authorsMap.has(r.bookId)) authorsMap.set(r.bookId, []);
    authorsMap.get(r.bookId)!.push({ author: r.author, position: r.position });
  }

  const narratorsMap = new Map<number, Array<{ narrator: NarratorRow; position: number }>>();
  for (const r of narratorResults) {
    if (!narratorsMap.has(r.bookId)) narratorsMap.set(r.bookId, []);
    narratorsMap.get(r.bookId)!.push({ narrator: r.narrator, position: r.position });
  }

  return bookRows.map((book) => ({
    ...book,
    importListName: null,
    authors: (authorsMap.get(book.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((r) => r.author),
    narrators: (narratorsMap.get(book.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((r) => r.narrator),
  }));
}
