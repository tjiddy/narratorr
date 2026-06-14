import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

// ============================================================================
// Public API v1 — Authors (read) (S4 — #1450)
// ============================================================================
//
// The public contract for the author reference resource: the wire DTO that hides
// every internal column (numeric rowid, `slug`, `asin`, timestamps), the
// composed (strict) list-query validator, and the `toAuthorV1` projector. Like
// the Books surface (#1449) these are schemas narratorr OWNS, so they are
// `.strict()` — the OPPOSITE of the prowlarr-compat surface (learning
// `compat-surface-zod-strip-not-strict`, #1198). `.strict()` is what makes the
// response boundary FAIL CLOSED: a projector regression that leaks an internal
// field is rejected at serialization, not silently stripped.

/**
 * The public Author DTO. Exposes ONLY `{ id, name }`, where `id` is the opaque
 * `publicId` (prefix `au_`), never the numeric rowid. `.strict()` is load-
 * bearing — any leaked internal field fails Fastify response serialization.
 */
export const authorV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type AuthorV1 = z.infer<typeof authorV1Schema>;

/**
 * Validator for `GET /api/v1/authors` query params: the v1 pagination building
 * block (limit/offset) made `.strict()` so unknown params (a misspelled
 * `cursor`, a snake_case `sort_by`) are REJECTED with a 400, not silently
 * stripped. No filter/sort params — a fixed deterministic order is the contract.
 */
export const authorV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type AuthorV1ListQuery = z.infer<typeof authorV1ListQuerySchema>;

/**
 * Minimal structural shape `toAuthorV1` reads. The server's reference row
 * (`ReferenceRow`) is structurally assignable to this — declaring it here keeps
 * the shared schema layer free of server imports while the projector still
 * accepts the real row.
 */
export interface AuthorV1Source {
  publicId: string;
  name: string;
}

/**
 * Project a reference author row to the public `AuthorV1` DTO. Emits ONLY the
 * public fields: `id` is the opaque `publicId`; every internal column (numeric
 * rowid, `slug`, `asin`, timestamps) is dropped by omission.
 */
export function toAuthorV1(row: AuthorV1Source): AuthorV1 {
  return { id: row.publicId, name: row.name };
}
