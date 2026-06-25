import { asc, eq, count as countFn } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { authors, narrators, series } from '../../db/schema.js';
import type { PaginationParams } from '../../shared/schemas/common.js';

// ============================================================================
// Reference reads — authors / narrators / series (S4 — #1450)
// ============================================================================
//
// The minimal read path behind the native `/api/v1` reference endpoints. The
// three reference tables (`authors`, `narrators`, `series`) share the same
// `{ id, publicId, name }` projection and the same access pattern: a paginated,
// deterministically-ordered list with a full unpaginated `count(*)` total, plus
// a `getById(rowid)` for the opaque-key detail lookup. Keeping the Drizzle
// queries here (not in the route handlers) matches the codebase's
// "business logic in services" convention.
//
// These reads operate on the BASE reference tables, so a row with zero
// associated books (e.g. a Hardcover-sourced series not linked to any local
// book) is still listed and fetchable — book linkage is irrelevant here.

/** The slim reference row the v1 projectors read: opaque id + name only. The
 *  numeric `id` is internal (used solely to resolve `:publicId` → row); the DTO
 *  never exposes it. */
export interface ReferenceRow {
  id: number;
  publicId: string;
  name: string;
}

/** A paginated reference list: the page rows plus the full unpaginated total. */
export interface ReferenceListResult {
  data: ReferenceRow[];
  total: number;
}

/** The three reference tables this service reads. All share the
 *  `{ id, publicId, name }` column shape the generic helpers select. */
type ReferenceTable = typeof authors | typeof narrators | typeof series;

/**
 * Default page size when the client omits `limit`. The v1 list contract caps
 * `limit` at 500; an omitted limit returns a bounded first page rather than the
 * entire (potentially large) reference table.
 */
const DEFAULT_REFERENCE_LIMIT = 120;

/**
 * Read-only access to the reference entities exposed by the native public API
 * v1 surface. One service for all three tables because their read shape is
 * identical — the per-entity methods delegate to the generic `list`/`getById`
 * helpers, narrowing the table to a single representative so Drizzle resolves
 * one overload (mirroring `resolveByPublicId` in `utils/public-id.ts`).
 */
export class ReferenceReadService {
  constructor(private db: Db) {}

  async listAuthors(pagination: PaginationParams): Promise<ReferenceListResult> {
    return this.list(authors, pagination);
  }

  async getAuthorById(id: number): Promise<ReferenceRow | null> {
    return this.getById(authors, id);
  }

  async listNarrators(pagination: PaginationParams): Promise<ReferenceListResult> {
    return this.list(narrators, pagination);
  }

  async getNarratorById(id: number): Promise<ReferenceRow | null> {
    return this.getById(narrators, id);
  }

  async listSeries(pagination: PaginationParams): Promise<ReferenceListResult> {
    return this.list(series, pagination);
  }

  async getSeriesById(id: number): Promise<ReferenceRow | null> {
    return this.getById(series, id);
  }

  /**
   * Paginated list ordered by `name` ascending with `id` as a stable tiebreak,
   * so offset pagination is deterministic across pages even when names collide.
   * `total` is the full unpaginated row count — independent of `limit`/`offset`.
   */
  private async list(table: ReferenceTable, pagination: PaginationParams): Promise<ReferenceListResult> {
    const t = table as typeof authors;
    const limit = pagination.limit ?? DEFAULT_REFERENCE_LIMIT;
    const offset = pagination.offset ?? 0;

    const data = await this.db
      .select({ id: t.id, publicId: t.publicId, name: t.name })
      .from(t)
      .orderBy(asc(t.name), asc(t.id))
      .limit(limit)
      .offset(offset);

    const totalRows = await this.db.select({ value: countFn() }).from(t);
    return { data, total: Number(totalRows[0]?.value ?? 0) };
  }

  /** Fetch a single reference row by internal rowid, or `null` when missing. */
  private async getById(table: ReferenceTable, id: number): Promise<ReferenceRow | null> {
    const t = table as typeof authors;
    const rows = await this.db
      .select({ id: t.id, publicId: t.publicId, name: t.name })
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
