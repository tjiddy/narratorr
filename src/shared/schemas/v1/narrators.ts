import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

// ============================================================================
// Public API v1 — Narrators (read) (S4 — #1450)
// ============================================================================
//
// The public contract for the narrator reference resource. Mirrors the Authors
// surface (#1450): a `.strict()` `{ id, name }` DTO (opaque `id` = `publicId`,
// prefix `nr_`), a `.strict()` list-query validator, and the `toNarratorV1`
// projector. Strictness is deliberate — narratorr OWNS these schemas, so a
// leaked internal column (numeric rowid, `slug`, timestamps) fails serialization
// rather than being silently stripped (learning
// `compat-surface-zod-strip-not-strict`, #1198).

/**
 * The public Narrator DTO. Exposes ONLY `{ id, name }`, where `id` is the opaque
 * `publicId` (prefix `nr_`). `.strict()` makes the response boundary fail closed.
 */
export const narratorV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type NarratorV1 = z.infer<typeof narratorV1Schema>;

/**
 * Validator for `GET /api/v1/narrators` query params: the v1 pagination building
 * block (limit/offset) made `.strict()` so unknown params are rejected with 400.
 */
export const narratorV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type NarratorV1ListQuery = z.infer<typeof narratorV1ListQuerySchema>;

/**
 * Minimal structural shape `toNarratorV1` reads. The server's `ReferenceRow` is
 * structurally assignable to this, keeping the shared layer free of server
 * imports.
 */
export interface NarratorV1Source {
  publicId: string;
  name: string;
}

/**
 * Project a reference narrator row to the public `NarratorV1` DTO. Emits ONLY
 * `{ id, name }` (`id` = opaque `publicId`); internal columns are dropped.
 */
export function toNarratorV1(row: NarratorV1Source): NarratorV1 {
  return { id: row.publicId, name: row.name };
}
