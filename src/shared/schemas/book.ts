import { z } from 'zod';
import { tagModeSchema } from './settings/tagging.js';

// ============================================================================
// Book schemas
// ============================================================================

export const BOOK_STATUSES = ['wanted', 'searching', 'downloading', 'importing', 'imported', 'missing', 'failed'] as const;
export const bookStatusSchema = z.enum(BOOK_STATUSES);
export type BookStatus = z.infer<typeof bookStatusSchema>;

// ----------------------------------------------------------------------------
// Canonical book lifecycle (#1444, epic #1441 / S2a)
// ----------------------------------------------------------------------------
//
// `BOOK_STATUSES` above IS the canonical lifecycle vocabulary — the 7 first-class
// states (`wanted, searching, downloading, importing, imported, missing, failed`)
// that the book detail screen and status badges render directly via
// `bookStatusConfig` (`src/client/lib/status.ts`). This block does NOT introduce
// a new parallel enum; it blesses the existing set as canonical and gives the
// "lifecycle" concept a name without a blast-radius rename.
//
// Naming decision: keep `BOOK_STATUSES` / `bookStatusSchema` / `BookStatus` as
// the canonical identifiers. `BookLifecycle` is a thin type alias (re-export),
// NOT a rename — a hard rename would have to travel with the DB enum usages
// (`books.status`, `bookStatusAtGrab` in `src/db/schema.ts`), the schema-db
// alignment test (`src/shared/schema-db-alignment.test.ts`), `bookStatusConfig`,
// and every `BookStatus` consumer, for purely cosmetic gain — and would risk the
// drizzle migration-prompt hang in successor stories (S2b/S2c) that actually move
// the column. The granular states remain what badges/detail render; buckets below
// are a presentation/grouping layer ONLY.
export type BookLifecycle = BookStatus;

/**
 * Library status-filter dropdown buckets (`All` is "no filter", so it is not a
 * key here — it maps to every state). This is a PRESENTATION/GROUPING layer used
 * only by the library filter dropdown and `getStats` per-bucket counts. It is the
 * cleaned-up successor to the bucket grouping currently duplicated across three
 * uncoordinated sites that successor stories (S2b–S2e) converge onto this single
 * source of truth:
 *   1. server filter WHERE  — `TAB_STATUS_MAP` (`book-list.service.ts`)
 *   2. server counts        — `getStats` inline sums (`book-list.service.ts`)
 *   3. client dropdown      — `matchesStatusFilter` / `filterTabs` (`pages/library/helpers.ts`)
 *                             + `VALID_STATUS_FILTERS` (`pages/library/useLibraryFilters.ts`)
 *
 * Invariant (enforced in book.test.ts, the property S2d's `getStats` tests rely on):
 * the buckets PARTITION the canonical states — their union equals all 7 states,
 * they are pairwise disjoint, and no bucket references a non-canonical state. That
 * partition is why per-bucket counts sum to the total book count.
 *
 * NOTE (S2a scope): this constant is purely additive — it changes no runtime
 * behavior. Rewiring the three sites above onto it is S2d's job; do NOT delete or
 * re-point `TAB_STATUS_MAP`, `getStats`, or the client helpers in this story.
 */
export const LIBRARY_FILTER_BUCKETS = {
  wanted: ['wanted'],
  downloading: ['searching', 'downloading'],
  imported: ['importing', 'imported'],
  failed: ['failed'],
  missing: ['missing'],
} as const satisfies Record<string, readonly BookLifecycle[]>;

/** A concrete (non-`All`) library filter bucket key. */
export type LibraryFilterBucket = keyof typeof LIBRARY_FILTER_BUCKETS;

/** Full set of library filter dropdown values, including `all` (= no filter). */
export const LIBRARY_FILTER_VALUES = ['all', ...Object.keys(LIBRARY_FILTER_BUCKETS)] as const;
export type LibraryFilterValue = 'all' | LibraryFilterBucket;

export const ENRICHMENT_STATUSES = ['pending', 'enriched', 'failed', 'skipped', 'file-enriched'] as const;
export const enrichmentStatusSchema = z.enum(ENRICHMENT_STATUSES);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;

export const bookSortFieldSchema = z.enum(['createdAt', 'title', 'author', 'narrator', 'series', 'quality', 'size', 'format']);
export type BookSortField = z.infer<typeof bookSortFieldSchema>;

export const bookSortDirectionSchema = z.enum(['asc', 'desc']);
export type BookSortDirection = z.infer<typeof bookSortDirectionSchema>;

export const bookListQuerySchema = z.object({
  status: bookStatusSchema.optional(),
  search: z.string().optional(),
  author: z.string().optional(),
  series: z.string().optional(),
  narrator: z.string().optional(),
  sortField: bookSortFieldSchema.optional(),
  sortDirection: bookSortDirectionSchema.optional(),
});

export const bookAuthorInputSchema = z.object({
  name: z.string().trim().min(1, 'Author name cannot be empty'),
  asin: z.string().optional(),
});

export const createBookBodySchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  authors: z.array(bookAuthorInputSchema).default([]),
  narrators: z.array(z.string().trim().min(1, 'Narrator name cannot be empty')).optional(),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  asin: z.string().optional(),
  isbn: z.string().optional(),
  seriesName: z.string().optional(),
  seriesPosition: z.number().optional(),
  // Provider-known series identity — persisted into the `series` cache table
  // when present so the Series card can render without a separate provider
  // round-trip on first GET. Optional because not every Add Book payload
  // carries it (manual entry, providers without series ASINs).
  seriesAsin: z.string().optional(),
  seriesProvider: z.string().optional(),
  duration: z.number().optional(),
  publishedDate: z.string().optional(),
  genres: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  searchImmediately: z.boolean().optional(),
}).strict();

export const updateBookBodySchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').optional(),
  authors: z.array(bookAuthorInputSchema).min(1).optional(),
  narrators: z.array(z.string()).optional(),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  status: bookStatusSchema.optional(),
  seriesName: z.string().nullable().optional(),
  seriesPosition: z.number().nullable().optional(),
}).strict();

/**
 * Narrow request schema for `POST /api/books/:id/fix-match`. Replacement
 * metadata is NOT client-supplied — the server fetches the canonical record
 * itself via `MetadataService.lookupForFixMatch(asin)`.
 */
export const fixMatchRequestSchema = z.object({
  asin: z.string().trim().min(1, 'ASIN is required'),
  renameFiles: z.boolean().optional(),
  retagFiles: z.boolean().optional(),
}).strict();
export type FixMatchRequest = z.infer<typeof fixMatchRequestSchema>;

export const deleteBookQuerySchema = z.object({
  deleteFiles: z.string().optional(),
});

/**
 * User-facing tag field names the preview modal exposes a per-field checkbox for.
 * `track` covers both `track` and `trackTotal` (they're a bundle in ffmpeg args).
 */
export const RETAG_EXCLUDABLE_FIELDS = [
  'artist',
  'albumArtist',
  'album',
  'title',
  'composer',
  'grouping',
  'track',
] as const;
export const retagExcludableFieldSchema = z.enum(RETAG_EXCLUDABLE_FIELDS);
export type RetagExcludableField = z.infer<typeof retagExcludableFieldSchema>;

export const retagBodySchema = z.object({
  excludeFields: z.array(retagExcludableFieldSchema).optional(),
  mode: tagModeSchema.optional(),
  embedCover: z.boolean().optional(),
}).strict().nullish();
export type RetagBody = z.infer<typeof retagBodySchema>;

/**
 * Query parameters for `GET /api/books/:id/retag/preview`. `embedCover` is
 * coerced from string (`'true'`/`'false'`) to boolean because URL query strings
 * carry no native boolean — undefined query params fall back to settings.
 */
export const retagPreviewQuerySchema = z.object({
  mode: tagModeSchema.optional(),
  embedCover: z.enum(['true', 'false']).optional().transform(v => v === undefined ? undefined : v === 'true'),
}).strict();
export type RetagPreviewQuery = z.infer<typeof retagPreviewQuerySchema>;

export type BookAuthorInput = z.infer<typeof bookAuthorInputSchema>;
export type BookListQuery = z.infer<typeof bookListQuerySchema>;
export type CreateBookBody = z.infer<typeof createBookBodySchema>;
export type UpdateBookBody = z.infer<typeof updateBookBodySchema>;
export type DeleteBookQuery = z.infer<typeof deleteBookQuerySchema>;
