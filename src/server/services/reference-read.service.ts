import { asc, eq, count as countFn } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import { authors, narrators, series } from '@db/schema.js';
import type { PaginationParams } from '@shared/schemas/common.js';

// Read base reference tables directly so unlinked rows remain visible.

// Numeric id is internal lookup state and is never exposed by the DTO.
export interface ReferenceRow {
  id: number;
  publicId: string;
  name: string;
}

export interface ReferenceListResult {
  data: ReferenceRow[];
  total: number;
}

type ReferenceTable = typeof authors | typeof narrators | typeof series;

// Omitted limits stay bounded; the v1 schema caps explicit limits at 500.
const DEFAULT_REFERENCE_LIMIT = 120;

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

  // Stable id tiebreak makes offset pagination deterministic; total is unpaginated.
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
