import { z } from 'zod';
import {
  bookStatusSchema,
  bookSortFieldSchema,
  bookSortDirectionSchema,
  type BookStatus,
} from '../book.js';
import { v1PaginationParamsSchema, v1ErrorEnvelopeSchema } from './common.js';

// ============================================================================
// Public API v1 — Books (S3 — #1449)
// ============================================================================
//
// The first concrete resource projected through the native `/api/v1` serializer
// boundary. Everything here is the *public contract*: the wire DTO that hides
// internal columns (numeric rowid, grab ids, FK columns, enrichment internals,
// slug/asin/timestamps), the composed (strict) list query validator, and the
// `toBookV1` projector that maps a hydrated book row to the DTO.
//
// Strictness is deliberate: native v1 validators/serializers are schemas
// narratorr OWNS, so they use `.strict()` (reject unknown keys) — the OPPOSITE
// of the prowlarr-compat surface, which must stay `.strip()` (learning
// `compat-surface-zod-strip-not-strict`, #1198). On the response side, `.strict()`
// is what makes the boundary FAIL CLOSED: a future projector regression that
// leaks an internal field is rejected by serialization rather than silently
// stripped and shipped.

// ----------------------------------------------------------------------------
// Item schema (response DTO) — strict, fail-closed
// ----------------------------------------------------------------------------

/** A related person (author/narrator) on the public book DTO: opaque id + name
 *  only. `.strict()` so a leaked `slug`/`asin`/timestamp fails serialization. */
export const bookV1PersonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

/** The public `series` shape: projected from the book row's denormalized
 *  `seriesName`/`seriesPosition`. No series opaque id — series-as-a-resource is
 *  deferred to S4. The whole value is `null` when the book has no series. */
export const bookV1SeriesSchema = z
  .object({
    name: z.string(),
    position: z.number().nullable(),
  })
  .strict()
  .nullable();

/**
 * The public Book DTO. Exposes ONLY `{ id, title, authors, narrators, series,
 * status }`. `.strict()` is load-bearing: it is what makes Fastify response-
 * schema enforcement fail closed on any internal field a projector regression
 * might leak (nested `.strict()` on person/series catches nested leaks too).
 */
export const bookV1Schema = z
  .object({
    id: z.string(),
    title: z.string(),
    authors: z.array(bookV1PersonSchema),
    narrators: z.array(bookV1PersonSchema),
    series: bookV1SeriesSchema,
    status: bookStatusSchema,
  })
  .strict();

export type BookV1 = z.infer<typeof bookV1Schema>;

// ----------------------------------------------------------------------------
// List query validator — composed strict
// ----------------------------------------------------------------------------

/**
 * Validator for `GET /api/v1/books` query params. Composed from the non-strict
 * `v1PaginationParamsSchema` building block (limit/offset) plus the v1 filter +
 * sort params, then `.strict()` at the COMPOSED level so unknown params
 * (a misspelled `cursor`, a snake_case `sort_by`) are REJECTED with a 400, not
 * silently stripped. Strictness is applied here, never on the standalone
 * pagination sub-schema — that would reject the filter/sort keys when composed.
 *
 * `status` is a canonical `BOOK_STATUSES` literal filtered by EXACT match — the
 * public filter vocabulary equals the DTO `status` vocabulary. Library
 * presentation buckets (`LIBRARY_FILTER_BUCKETS`) are NOT part of this contract.
 */
export const bookV1ListQuerySchema = v1PaginationParamsSchema
  .extend({
    status: bookStatusSchema.optional(),
    author: z.string().optional(),
    series: z.string().optional(),
    narrator: z.string().optional(),
    sortField: bookSortFieldSchema.optional(),
    sortDirection: bookSortDirectionSchema.optional(),
  })
  .strict();

export type BookV1ListQuery = z.infer<typeof bookV1ListQuerySchema>;

// ----------------------------------------------------------------------------
// Create request validator + the 409 conflict response (S — #1520)
// ----------------------------------------------------------------------------

/**
 * Validator for `POST /api/v1/books`. The public add-by-ASIN contract is
 * ASIN-ONLY: the server hydrates the full record itself (`MetadataService`),
 * so the client never supplies title/author/etc. `.trim().min(1)` (mirroring
 * `fixMatchRequestSchema`) rejects `''`/`'   '` BEFORE any lookup — a bare
 * `z.string()` would let a blank ASIN skip `findDuplicate`'s ASIN branch and
 * reach the provider. `.strict()` per the v1 owned-schema convention: an extra
 * key beyond `{ asin }` is a `400`, not silently stripped.
 */
export const createBookV1RequestSchema = z
  .object({
    asin: z.string().trim().min(1, 'ASIN is required'),
  })
  .strict();

export type CreateBookV1Request = z.infer<typeof createBookV1RequestSchema>;

/**
 * The `409 Conflict` body for an already-present ASIN. It is NOT the bare
 * `v1ErrorEnvelopeSchema`: it carries `existingId` (the existing book's opaque
 * `publicId`) at the TOP LEVEL alongside `error`. `existingId` makes a
 * lost-response retry safe — a retry of a successful create re-resolves to this
 * 409 and can still find/poll the book it created — and doubles as the
 * link-to-existing signal. Declared as a dedicated response schema so the
 * `reply.status(409).send(...)` typechecks under `fastify-type-provider-zod`'s
 * send-union narrowing (learning `zod-type-provider-send-union-narrowing`).
 */
export const bookExistsV1Schema = v1ErrorEnvelopeSchema
  .extend({
    existingId: z.string(),
  })
  .strict();

export type BookExistsV1 = z.infer<typeof bookExistsV1Schema>;

// ----------------------------------------------------------------------------
// Projector — hydrated row -> public DTO
// ----------------------------------------------------------------------------

/**
 * Minimal structural shape `toBookV1` reads. The server's `BookWithAuthor` row
 * (from `BookListService.getAll()` / `BookService.getById()`) is structurally
 * assignable to this — declaring it here keeps the shared schema layer free of
 * server imports while the projector still accepts the real hydrated row.
 */
export interface BookV1Source {
  publicId: string;
  title: string;
  status: BookStatus;
  seriesName: string | null;
  seriesPosition: number | null;
  authors: ReadonlyArray<{ publicId: string; name: string }>;
  narrators: ReadonlyArray<{ publicId: string; name: string }>;
}

/**
 * Project a hydrated book row to the public `BookV1` DTO. Strips every internal
 * column (numeric rowid, `lastGrabGuid`/`lastGrabInfoHash`, FK columns,
 * enrichment internals, `slug`/`asin`/timestamps) by emitting ONLY the public
 * fields. `id` fields are opaque `publicId`s; `status` is copied through from
 * the authoritative `row.status` (books.status is authoritative per S2c #1446 —
 * the DTO does NOT recompute lifecycle state). Author/narrator ordering is
 * preserved (the service already returns them primary-first).
 */
export function toBookV1(row: BookV1Source): BookV1 {
  return {
    id: row.publicId,
    title: row.title,
    authors: row.authors.map((a) => ({ id: a.publicId, name: a.name })),
    narrators: row.narrators.map((n) => ({ id: n.publicId, name: n.name })),
    series: row.seriesName
      ? { name: row.seriesName, position: row.seriesPosition ?? null }
      : null,
    status: row.status,
  };
}
