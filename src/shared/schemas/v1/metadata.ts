import { z } from 'zod';
import { bookStatusSchema } from '../book.js';

// ============================================================================
// Public API v1 — Metadata search (v1.1 — #1519)
// ============================================================================
//
// The public projection of a provider metadata-search *book* result. This is a
// thin public wrapper over the internal `MetadataService.search()` — it exposes
// ONLY the per-book result shape (the top-level `authors`/`series`/`warnings`
// arrays of `MetadataSearchResults` are intentionally dropped; the consumer
// needs books). These are PRE-LIBRARY results: they carry `asin`, NOT a
// `publicId`, and people are `{ name, asin? }` — deliberately different from
// `BookV1`'s `{ id, name }`, because they are not library entities yet.
//
// Strictness is deliberate and load-bearing, exactly as in `books.ts`: native
// v1 schemas are a contract narratorr OWNS, so they use `.strict()` (reject
// unknown keys). This is the OPPOSITE of the prowlarr-compat surface, which must
// stay `.strip()` (learning `compat-surface-zod-strip-not-strict`, #1198). On
// the response side `.strict()` is what makes the boundary FAIL CLOSED: a future
// projector regression that leaks an internal `BookMetadata` field (e.g.
// `providerId`, `isbn`, `description`) is rejected at serialization rather than
// silently stripped and shipped.

// ----------------------------------------------------------------------------
// Item schema (response DTO) — strict, fail-closed
// ----------------------------------------------------------------------------

/** A result author: `{ name, asin? }`. `.strict()` so a leaked provider field
 *  fails serialization. `asin` is optional — providers don't always supply it. */
export const metadataSearchResultV1AuthorSchema = z
  .object({
    name: z.string(),
    asin: z.string().optional(),
  })
  .strict();

/** A result narrator: `{ name }` ONLY. The provider gives narrators as plain
 *  strings (no asin), so the DTO never carries an `asin` field for narrators. */
export const metadataSearchResultV1NarratorSchema = z
  .object({
    name: z.string(),
  })
  .strict();

/** A result series: `{ name, position? }`. `position` is optional (the source
 *  `SeriesRefSchema.position` is optional). `.strict()` to fail closed. */
export const metadataSearchResultV1SeriesSchema = z
  .object({
    name: z.string(),
    position: z.number().optional(),
  })
  .strict();

/**
 * The public metadata-search result DTO. Exposes ONLY
 * `{ asin?, title, authors, narrators, series?, cover?, publishedDate? }`.
 * `.strict()` (here and on every nested object) is load-bearing: it makes
 * Fastify response-schema enforcement fail closed on any internal `BookMetadata`
 * field a projector regression might leak. `narrators` is a REQUIRED array
 * (defaults to `[]` when the source omits narrators) so consumers always get an
 * array, never `undefined`.
 *
 * `library` is the narratorr-only cross-reference (#1537): when the result's
 * ASIN matches a book already in the library it carries `{ bookId, status }` —
 * the `bk_` publicId and the raw canonical `BookStatus`. It is additive,
 * optional, and best-effort: the route fills it AFTER projection (the projector
 * keeps reading only public provider fields), so a library-lookup failure leaves
 * it absent rather than failing the search. `status` reuses `bookStatusSchema`
 * (NOT a parallel enum) so the consumer's vocabulary equals `BookV1`'s with zero
 * translation; the consumer owns the tri-state collapse, narratorr emits facts.
 */
export const metadataSearchResultV1Schema = z
  .object({
    asin: z.string().optional(),
    title: z.string(),
    authors: z.array(metadataSearchResultV1AuthorSchema),
    narrators: z.array(metadataSearchResultV1NarratorSchema),
    series: metadataSearchResultV1SeriesSchema.optional(),
    cover: z.string().optional(),
    publishedDate: z.string().optional(),
    library: z
      .object({
        bookId: z.string(),
        status: bookStatusSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type MetadataSearchResultV1 = z.infer<typeof metadataSearchResultV1Schema>;

// ----------------------------------------------------------------------------
// Query validator — strict, same bound as the internal metadata search
// ----------------------------------------------------------------------------

/**
 * Validator for `GET /api/v1/metadata/search` query params. `q` is required,
 * trimmed, `min(1)` / `max(500)` — the SAME bound as the internal
 * `metadataSearchQuerySchema` (`src/shared/schemas/metadata.ts`); the public
 * wrapper must not relax it. `.strict()` rejects unknown params with a 400.
 */
export const metadataSearchV1QuerySchema = z
  .object({
    q: z.string().trim().min(1, 'Query is required').max(500),
  })
  .strict();

export type MetadataSearchV1Query = z.infer<typeof metadataSearchV1QuerySchema>;

// ----------------------------------------------------------------------------
// Projector — provider book result -> public DTO
// ----------------------------------------------------------------------------

/**
 * Minimal STRUCTURAL shape `toMetadataSearchResultV1` reads. The core
 * `BookMetadata` (`src/core/metadata/schemas.ts`) is structurally assignable to
 * this — declaring it here keeps the shared schema layer free of `src/core`
 * imports (forbidden by the `no-restricted-imports` guard in `eslint.config.js`
 * for `src/shared/**`), while the route's projector call still accepts the real
 * metadata result. Mirrors the `ReleaseV1Source` interface in `actions.ts`.
 *
 * Only the fields the projector reads are listed. Note the source-shape
 * reconciliation vs a naive reading of the spec:
 *   - `narrators` are plain strings (no asin) — projected to `{ name }`.
 *   - the cover field is `coverUrl` — projected to the public `cover`.
 *   - series is a plural `series[]` plus an optional singular `seriesPrimary` —
 *     the DTO exposes a single `series` projected from `seriesPrimary ?? series[0]`.
 */
export interface MetadataSearchResultV1Source {
  asin?: string | undefined;
  title: string;
  authors: ReadonlyArray<{ name: string; asin?: string | undefined }>;
  narrators?: ReadonlyArray<string> | undefined;
  series?: ReadonlyArray<{ name: string; position?: number | undefined }> | undefined;
  seriesPrimary?: { name: string; position?: number | undefined } | undefined;
  coverUrl?: string | undefined;
  publishedDate?: string | undefined;
}

/**
 * Project a provider book result to the public `MetadataSearchResultV1` DTO.
 * Field-by-field — copies ONLY the public fields, so every other `BookMetadata`
 * field (`subtitle`, `isbn`, `goodreadsId`, `providerId`, `description`,
 * `publisher`, `language`, `duration`, `genres`, `relevance`, `formatType`,
 * `contentDeliveryType`, `alternateAsins`) is left out of the projection.
 *
 * Optional fields use conditional spreads (not explicit `undefined`) to satisfy
 * `exactOptionalPropertyTypes` and the `.strict()` schema. `narrators` always
 * emits an array (coalesced to `[]`). `series` is `seriesPrimary ?? series[0]`.
 * An asin-less book is returned anyway (asin omitted) — NOT filtered out.
 */
export function toMetadataSearchResultV1(
  source: MetadataSearchResultV1Source,
): MetadataSearchResultV1 {
  const series = source.seriesPrimary ?? source.series?.[0];
  return {
    title: source.title,
    authors: source.authors.map((a) => ({
      name: a.name,
      ...(a.asin !== undefined && { asin: a.asin }),
    })),
    narrators: (source.narrators ?? []).map((name) => ({ name })),
    ...(source.asin !== undefined && { asin: source.asin }),
    ...(source.coverUrl !== undefined && { cover: source.coverUrl }),
    ...(source.publishedDate !== undefined && { publishedDate: source.publishedDate }),
    ...(series !== undefined && {
      series: {
        name: series.name,
        ...(series.position !== undefined && { position: series.position }),
      },
    }),
  };
}
