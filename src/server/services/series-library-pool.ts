import { asc, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DbOrTx } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { LibraryBookSummary } from './series-title-match.js';
import { buildSeriesNameTargets, seriesNameMatchesTargets } from '../utils/series-name-targets.js';
import { parseClearedFields } from '../utils/cleared-fields.js';

/**
 * Carrying the raw `series_name` lets a caller re-derive a narrower name view from rows it already
 * holds instead of issuing a second scan. Structurally still a LibraryBookSummary, so matcher,
 * card-projection, and seeding consumers need no signature change.
 */
export interface PoolBook extends LibraryBookSummary {
  seriesName: string;
  status: BookStatus;
}

// Keep tombstones separate so the matcher's LibraryBookSummary contract stays narrow.
export interface LibraryPool {
  books: PoolBook[];
  positionClearedIds: Set<number>;
}

/**
 * The loader's own membership rule re-applied with targets built from one name, so a folded-equal
 * spelling stays in. Byte equality here would resurrect the #2175 defect on the seeding path.
 */
export function narrowPoolToSeriesName(pool: readonly PoolBook[], seriesName: string): PoolBook[] {
  const targets = buildSeriesNameTargets([seriesName]);
  return pool.filter((book) => seriesNameMatchesTargets(targets, book.seriesName));
}

/**
 * Loads candidates and position tombstones in one snapshot while keeping the
 * tombstones outside matcher input. Membership uses the cache lookup's folded
 * equivalence class so case-drifted books remain on their siblings' cards.
 */
export async function loadLibraryBooksForSeriesNames(
  executor: DbOrTx,
  seriesNames: readonly string[],
  log: FastifyBaseLogger,
): Promise<LibraryPool> {
  if (seriesNames.length === 0) return { books: [], positionClearedIds: new Set() };
  const targets = buildSeriesNameTargets([...seriesNames]);
  // Filter folded spellings in JS: a dynamic IN list is unbounded toward libSQL's
  // 32,766-parameter cap, while unindexed series_name already requires a full scan.
  // ORDER BY id is a matcher contract: greedy first-claim matching makes order
  // observable, and a covering index can otherwise change which book bind rewrites.
  const rows = await executor
    .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition, userClearedFields: books.userClearedFields, seriesName: books.seriesName, status: books.status })
    .from(books)
    .where(isNotNull(books.seriesName))
    .orderBy(asc(books.id));
  const positionClearedIds = new Set<number>();
  const pool: PoolBook[] = [];
  for (const row of rows) {
    if (!seriesNameMatchesTargets(targets, row.seriesName!)) continue;
    pool.push({ id: row.id, title: row.title, seriesPosition: row.seriesPosition, seriesName: row.seriesName!, status: row.status });
    if (parseClearedFields(row.userClearedFields, log, row.id).includes('seriesPosition')) {
      positionClearedIds.add(row.id);
    }
  }
  return { books: pool, positionClearedIds };
}
