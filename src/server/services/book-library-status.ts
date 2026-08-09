import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { CompanionEbookRow } from './types.js';
import type { LibraryStatusByAsin } from './book.service.js';
import { findCompanionEbooksByBookIds } from './companion-ebook.repository.js';
import { toCompanionEbookV1 } from '@shared/schemas/v1/companion-ebook.js';

export async function findLibraryStatusByAsins(
  db: Db,
  asins: string[],
  options: { companionEnabled: boolean },
): Promise<Map<string, LibraryStatusByAsin>> {
  const map = new Map<string, LibraryStatusByAsin>();
  if (asins.length === 0) return map;

  const uppered = asins.map((a) => a.toUpperCase());
  const rows = await db
    .select({ id: books.id, bookId: books.publicId, status: books.status, asin: books.asin })
    .from(books)
    // Restate the partial-index condition or SQLite scans the books table.
    .where(and(inArray(sql`upper(${books.asin})`, uppered), isNotNull(books.asin)));

  const matchedIds = rows.filter((r) => r.asin != null).map((r) => r.id);
  const companionByBookId: Map<number, CompanionEbookRow> =
    options.companionEnabled && matchedIds.length > 0
      ? await findCompanionEbooksByBookIds(db, matchedIds)
      : new Map();

  for (const row of rows) {
    if (row.asin == null) continue;
    const status = row.status as BookStatus;
    map.set(row.asin.toUpperCase(), {
      bookId: row.bookId,
      status,
      companionEbook: toCompanionEbookV1({
        enabled: options.companionEnabled,
        bookStatus: status,
        observation: companionByBookId.get(row.id),
      }),
    });
  }
  return map;
}
