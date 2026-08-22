import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { authors, bookAuthors, books, importListExclusions, importLists, settingsMigrations } from '@db/schema.js';
import type { ImportListExclusionService } from './import-list-exclusion.service.js';
import { chunkArray } from '../utils/batch.js';
import { serializeError } from '../utils/serialize-error.js';

export const ADD_LEDGER_BACKFILL_ID = 'import-list-add-ledger-backfill-v1';

/**
 * Seven bound parameters per row against SQLite's 999-parameter statement ceiling. Sized against
 * this table's own column count rather than copied from another repository's id-chunk size, which
 * binds one parameter per row.
 */
const ROWS_PER_INSERT = 120;

/**
 * Seed the add ledger from the library that already exists, once, before the crons arm (#2530).
 *
 * Without it every book a list added before the upgrade is invisible to the new gate, so the first
 * post-upgrade rename of any of them reproduces the exact duplicate this issue is about.
 *
 * It runs EXACTLY once, guarded by a `settings_migrations` marker rather than by a per-row
 * already-covered check: a re-running backfill would resurrect a ledger row the operator
 * deliberately removed from the undo page. The marker READ, the candidate read, every insert and
 * the marker write share one transaction. That is what makes "exactly once" true: a mid-run crash
 * leaves neither a partial ledger nor a set marker, the marker guarantees the table holds no
 * `added` rows when the inserts run, and two overlapping calls cannot both observe an absent
 * marker — `createDb` serializes transactions on the connection, so the loser's read sees the
 * winner's committed marker. Reading the marker BEFORE the transaction is the same defect
 * `recordExclusion` documents for its own read/insert pair: both callers see nothing, both seed,
 * and `onConflictDoNothing` suppresses only the duplicate marker, never the duplicate ledger.
 *
 * A failure is caught and logged with the marker left unset, so the next boot retries — the
 * `migrateRejectWordsDefault` contract. Books whose `import_list_id` is already NULL (the list was
 * deleted first, `onDelete: 'set null'`) carry no provenance and are skipped: the same accepted
 * consequence the deletion path documents.
 */
export async function backfillImportListAddLedger(
  db: Db,
  exclusions: ImportListExclusionService,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    // One transaction, opened once: `recordExclusion` per row would serialize one transaction per
    // book on the connection and block boot.
    const seeded = await db.transaction(async (tx) => {
      const marker = await tx
        .select()
        .from(settingsMigrations)
        .where(eq(settingsMigrations.id, ADD_LEDGER_BACKFILL_ID))
        .limit(1);
      // null, not 0: an already-marked boot did no work, where 0 means it had none to do.
      if (marker.length > 0) return null;

      const candidates = await tx
        .select({
          title: books.title,
          asin: books.asin,
          importListId: books.importListId,
          importListName: importLists.name,
          authorName: authors.name,
        })
        .from(books)
        .leftJoin(importLists, eq(books.importListId, importLists.id))
        .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
        .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
        .where(isNotNull(books.importListId));

      const values = candidates.map((candidate) =>
        exclusions.buildExclusionValues(
          { title: candidate.title, asin: candidate.asin, authorName: candidate.authorName },
          { importListId: candidate.importListId, importListName: candidate.importListName },
          'added',
        ),
      );

      for (const chunk of chunkArray(values, ROWS_PER_INSERT)) {
        await tx.insert(importListExclusions).values(chunk);
      }

      await tx.insert(settingsMigrations).values({ id: ADD_LEDGER_BACKFILL_ID }).onConflictDoNothing();
      return values.length;
    });
    if (seeded === null) return;

    log.info({ migration: ADD_LEDGER_BACKFILL_ID, seeded }, 'Seeded the import list add ledger from existing list-sourced books');
  } catch (error: unknown) {
    log.warn(
      { migration: ADD_LEDGER_BACKFILL_ID, error: serializeError(error) },
      'Import list add-ledger backfill failed — will retry on next boot',
    );
  }
}
