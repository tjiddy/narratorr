import { type books } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { productionTypeSchema, type ProductionType } from '../../shared/schemas/book.js';
import type { BookRow } from './types.js';

/**
 * The public `BookService.create` payload (#1892). Includes the enrichment-only
 * `providerId` field — the wrapper consumes it, then strips it before reaching
 * the tx-scoped insert primitive.
 */
export interface CreateBookInput {
  title: string;
  authors: { name: string; asin?: string | undefined }[];
  narrators?: string[] | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  coverUrl?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  status?: BookRow['status'] | undefined;
  enrichmentStatus?: BookRow['enrichmentStatus'] | undefined;
  productionType?: ProductionType | undefined;
  providerId?: string | undefined;
  importListId?: number | undefined;
}

/**
 * The tx-scoped insert primitive's input (#1892): PRE-RESOLVED metadata with
 * `asin` already decided. It carries no `providerId` because enrichment has
 * already happened (or been skipped) before the primitive is reached. Derived
 * from `CreateBookInput` so the field shape stays single-sourced (DRY).
 */
export type ResolvedBookCreateInput = Omit<CreateBookInput, 'providerId'>;

/**
 * Build the `books` insert payload from resolved create input. `canonicalAsin`
 * is the already-canonicalized (#1733) ASIN. Validates the production_type enum
 * at this write boundary — SQLite text-enums emit no DB CHECK
 * (drizzle-sqlite-text-enum-no-db-check) — so an invalid value throws here,
 * before any row is written.
 */
export function buildNewBookValues(
  data: ResolvedBookCreateInput,
  canonicalAsin: string | null,
): typeof books.$inferInsert {
  return {
    publicId: generatePublicId('bk'),
    title: data.title,
    subtitle: data.subtitle,
    description: data.description,
    publisher: data.publisher,
    coverUrl: data.coverUrl,
    asin: canonicalAsin,
    isbn: data.isbn,
    seriesName: data.seriesName,
    seriesPosition: data.seriesPosition,
    duration: data.duration,
    publishedDate: data.publishedDate,
    genres: data.genres,
    status: data.status || 'wanted',
    enrichmentStatus: data.enrichmentStatus,
    productionType: productionTypeSchema.parse(data.productionType ?? 'unknown'),
    importListId: data.importListId,
  };
}
