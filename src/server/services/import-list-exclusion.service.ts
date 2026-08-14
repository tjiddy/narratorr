import { and, desc, eq, isNull, or, count as countFn, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import { importListExclusions } from '@db/schema.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { matchesLibraryIdentity, resolveAuthorSlug, type DedupIdentity } from '@shared/dedup.js';
import type { PaginatedResponse } from '@shared/schemas/common.js';
import type { ImportListExclusionRow } from './types.js';

/** What `recordExclusion` landed: `inserted` false means an existing row already covered the identity. */
export interface ExclusionRecordResult {
  row: ImportListExclusionRow;
  inserted: boolean;
}

/** Which list introduced the book. Display only — an exclusion applies to every list. */
export interface ExclusionProvenance {
  importListId: number | null;
  /** Snapshotted rather than joined, so the source stays readable after the list is deleted. */
  importListName: string | null;
}

function toDedupIdentity(row: ImportListExclusionRow): DedupIdentity {
  return { title: row.title, asin: row.asin, authorSlug: row.authorSlug, authorName: row.authorName };
}

/**
 * The rows `matchesLibraryIdentity` could possibly match, and no fewer.
 *
 * The predicate has three true-arms and an ASIN miss falls through all of them, so each disjunct is
 * included whenever its input exists rather than gated on the others. This deliberately diverges
 * from `gatherIncumbentIds`, which suppresses its authorless-title query when the candidate has an
 * ASIN: here an authorless candidate carrying one ASIN still matches an authorless row carrying a
 * different ASIN and an equal title, and that gate would never fetch the row.
 */
function candidateFilter(identity: DedupIdentity): SQL {
  const disjuncts: SQL[] = [];
  const canonicalAsin = canonicalizeAsin(identity.asin);
  if (canonicalAsin) disjuncts.push(eq(importListExclusions.asin, canonicalAsin));

  const slug = resolveAuthorSlug(identity);
  if (slug) {
    disjuncts.push(eq(importListExclusions.authorSlug, slug));
  } else {
    disjuncts.push(and(isNull(importListExclusions.authorSlug), eq(importListExclusions.title, identity.title))!);
  }

  return or(...disjuncts)!;
}

/**
 * Books an import list must not re-add, and the operator's undo for them (#2305).
 *
 * There is exactly one writer — `BookDeletionService` — so no HTTP-facing create exists; the routes
 * expose only the list and the removal.
 */
export class ImportListExclusionService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async getAll(
    pagination?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<ImportListExclusionRow>> {
    const [{ value: total } = { value: 0 }] = await this.db
      .select({ value: countFn() })
      .from(importListExclusions);

    // Second key because createdAt is a seconds-resolution default; without it a page boundary
    // can drop or repeat a row that shares its timestamp with the next one.
    let query = this.db
      .select()
      .from(importListExclusions)
      .orderBy(desc(importListExclusions.createdAt), desc(importListExclusions.id));

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const data = await query;
    return { data, total };
  }

  async getById(id: number): Promise<ImportListExclusionRow | null> {
    const results = await this.db
      .select()
      .from(importListExclusions)
      .where(eq(importListExclusions.id, id))
      .limit(1);
    return results[0] ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(importListExclusions).where(eq(importListExclusions.id, id));
    this.log.info({ id, title: existing.title }, 'Import list exclusion removed');
    return true;
  }

  /**
   * The gate's read: the matched row rather than a boolean, because the refusal reports its id.
   *
   * Deliberately NOT transactional. It runs once per synced item on the hot path, and it is
   * advisory — an exclusion recorded after this read simply admits one more book that the next
   * sync refuses.
   */
  async isExcluded(identity: DedupIdentity): Promise<ImportListExclusionRow | null> {
    return this.findMatch(this.db, identity);
  }

  /**
   * Record an exclusion for `identity`, or return the row that already covers it.
   *
   * The candidate read and the conditional insert share ONE transaction: split across two
   * statements, two concurrent deletes of the same book both observe no match and both insert.
   * Serialization is automatic — `createDb` routes every `db.transaction` through
   * `runSerializedTransaction` — so with no `tx` this must not be called from inside an
   * already-open transaction, which would throw `NestedTransactionError`.
   *
   * `tx` joins the caller's transaction instead, which is what keeps the read and the insert
   * together when the exclusion has to commit atomically with a book deletion. That arm is
   * side-effect-free because the owner may still roll back; it hands the outcome back so the owner
   * can call {@link logRecorded} after its commit.
   */
  async recordExclusion(
    identity: DedupIdentity,
    provenance: ExclusionProvenance,
    tx?: DbOrTx,
  ): Promise<ExclusionRecordResult> {
    const values = {
      asin: canonicalizeAsin(identity.asin),
      title: identity.title,
      authorName: identity.authorName ?? null,
      authorSlug: resolveAuthorSlug(identity),
      importListId: provenance.importListId,
      importListName: provenance.importListName,
    };

    const record = async (executor: DbOrTx): Promise<ExclusionRecordResult> => {
      const existing = await this.findMatch(executor, identity);
      if (existing) return { row: existing, inserted: false };
      const created = await executor.insert(importListExclusions).values(values).returning();
      return { row: created[0]!, inserted: true };
    };

    if (tx) return record(tx);

    const result = await this.db.transaction(record);
    this.logRecorded(result);
    return result;
  }

  /** Post-commit half of `recordExclusion(..., tx)` — the records this service would have written
   * itself. The converged case stays at `debug`: it reports that nothing was inserted. */
  logRecorded({ row, inserted }: ExclusionRecordResult): void {
    if (inserted) {
      this.log.info(
        { id: row.id, title: row.title, asin: row.asin, authorSlug: row.authorSlug },
        'Import list exclusion recorded',
      );
    } else {
      this.log.debug({ id: row.id, title: row.title }, 'Import list exclusion already recorded');
    }
  }

  /** Narrow in SQL, then apply the shared predicate in memory — the tolerant title arm has no
   * SQL form. Every candidate is tested because subtitle matching is non-transitive. */
  private async findMatch(
    executor: DbOrTx,
    identity: DedupIdentity,
  ): Promise<ImportListExclusionRow | null> {
    const rows = await executor
      .select()
      .from(importListExclusions)
      .where(candidateFilter(identity));
    return rows.find((row) => matchesLibraryIdentity(identity, toDedupIdentity(row))) ?? null;
  }
}
