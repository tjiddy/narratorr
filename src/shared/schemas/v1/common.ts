import { z } from 'zod';
import { paginationParamsSchema } from '../common.js';

// ============================================================================
// Public API v1 conventions (S0 — #1442)
// ============================================================================
//
// This module is the *canonical* contract for the native public API surface
// (`/api/v1/*`). It locks the envelope/pagination/error shapes so downstream
// read stories (S3+, #1449) import these types instead of re-deriving their
// own. Nothing here registers a route or changes runtime behavior — S3 builds
// the serializer boundary that *consumes* these types.
//
// The conventions, decided and recorded here (see also SECURITY.md
// "API Versioning Policy"):
//
//  - Surface split: `/api/*` is internal & unstable (no compat promise); the
//    public, supported API lives under `/api/v1/`. The Prowlarr/Readarr shim
//    at `/api/v1/indexer*` + `/api/v1/system/status`
//    (`src/server/routes/prowlarr-compat.ts`) is a documented contract
//    *exception*, NOT native v1.
//  - Pagination = offset/limit (reused from `paginationParamsSchema`, NOT
//    forked). A single-user library is not a feed; cursor pagination is
//    explicitly rejected.
//  - Filter + sort params: camelCase, short, optional (`sortField`,
//    `sortDirection`, `author`, `series`, `narrator`) — never `sort_by` /
//    `filter_author`. Matches `bookListQuerySchema`.
//  - Error envelope: `{ error: { code, message } }` (object, not bare string).
//    v1-ONLY — the internal `/api/*` handler
//    (`src/server/plugins/error-handler.ts`) keeps its ad-hoc shape and is NOT
//    retrofitted by this story.
//  - List response: `{ data, total }` (never a bare array), aligning with the
//    existing `PaginatedResponse<T>`.
//  - Dates: ISO 8601 strings — Fastify + `fastify-type-provider-zod` already
//    serialize `Date → ISO` automatically; no new serialization code needed.
//  - Request-validator strictness: native v1 validators are schemas narratorr
//    owns → use Zod `.strict()`. This is the OPPOSITE of the prowlarr-compat
//    surface, which must stay `.strip()` (learning
//    `compat-surface-zod-strip-not-strict`, #1198). v1 schemas must not drift
//    toward `.strip()`/`.passthrough()`.
//  - CORS: target shape is a configurable comma-separated allowlist for future
//    browser sidecars. Documented now; implementation deferred to the first
//    browser consumer (today CORS is a single `CORS_ORIGIN`,
//    `src/server/cors-config.ts`).
//  - Rate-limiting for the native public API v1 surface is deliberately OUT of
//    scope (single-user self-hosted threat model). Existing auth/filesystem
//    rate limits are unchanged.

// ----------------------------------------------------------------------------
// Error envelope — `{ error: { code, message } }`
// ----------------------------------------------------------------------------

/**
 * Canonical v1 error envelope. The public surface returns errors as an object
 * with a stable machine-readable `code` and a human-readable `message`, never
 * a bare string. `.strict()` keeps the inner shape locked.
 */
export const v1ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export type V1ErrorEnvelope = z.infer<typeof v1ErrorEnvelopeSchema>;

// ----------------------------------------------------------------------------
// Pagination — reuse, do not fork
// ----------------------------------------------------------------------------

/**
 * v1 pagination params. Intentionally an alias of the existing
 * `paginationParamsSchema` (offset/limit) so the public contract cannot drift
 * into a second, subtly-incompatible pagination shape.
 */
export const v1PaginationParamsSchema = paginationParamsSchema;

export type V1PaginationParams = z.infer<typeof v1PaginationParamsSchema>;

// ----------------------------------------------------------------------------
// List response — `{ data, total }` generic
// ----------------------------------------------------------------------------

/**
 * Build a v1 list-response schema for a given item schema. The shape is
 * `{ data: T[], total: number }` — a bare array is never a valid v1 list
 * response. Mirrors the existing `PaginatedResponse<T>` interface in
 * `../common.ts`; S3 (#1449) enforces this on actual responses.
 *
 * @example
 *   const bookListResponseSchema = v1ListResponseSchema(bookSchema);
 */
export function v1ListResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      data: z.array(itemSchema),
      total: z.number().int().min(0),
    })
    .strict();
}

/** Static type for a v1 list response of items `T`. */
export interface V1ListResponse<T> {
  data: T[];
  total: number;
}
