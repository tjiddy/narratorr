import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

// ============================================================================
// Public API v1 — Series (read) (S4 — #1450)
// ============================================================================
//
// The public contract for the series reference resource. The series table
// carries several internal/optional columns (`normalizedName`,
// `hardcoverSeriesId`, `authorName`, `description`, `imageUrl`, `lastFetchedAt`,
// timestamps) — NONE belong in the DTO. The projector emits only `{ id, name }`,
// and the `.strict()` response schema is the backstop: a future projector
// regression that leaks any of those internals fails serialization rather than
// being silently stripped (learning `compat-surface-zod-strip-not-strict`, #1198).

/**
 * The public Series DTO. Exposes ONLY `{ id, name }`, where `id` is the opaque
 * `publicId` (prefix `sr_`). `.strict()` makes the response boundary fail closed
 * against the series table's many internal columns.
 */
export const seriesV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type SeriesV1 = z.infer<typeof seriesV1Schema>;

/**
 * Validator for `GET /api/v1/series` query params: the v1 pagination building
 * block (limit/offset) made `.strict()` so unknown params are rejected with 400.
 */
export const seriesV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type SeriesV1ListQuery = z.infer<typeof seriesV1ListQuerySchema>;

/**
 * Minimal structural shape `toSeriesV1` reads. The server's `ReferenceRow` is
 * structurally assignable to this, keeping the shared layer free of server
 * imports.
 */
export interface SeriesV1Source {
  publicId: string;
  name: string;
}

/**
 * Project a reference series row to the public `SeriesV1` DTO. Emits ONLY
 * `{ id, name }` (`id` = opaque `publicId`); every internal column
 * (`normalizedName`, `hardcoverSeriesId`, `authorName`, `description`,
 * `imageUrl`, `lastFetchedAt`, timestamps) is dropped by omission.
 */
export function toSeriesV1(row: SeriesV1Source): SeriesV1 {
  return { id: row.publicId, name: row.name };
}
