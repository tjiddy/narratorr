import { z } from 'zod';
import { tagModeSchema } from './settings/tagging.js';

export const BOOK_STATUSES = ['wanted', 'searching', 'downloading', 'importing', 'imported', 'missing', 'failed'] as const;
export const bookStatusSchema = z.enum(BOOK_STATUSES);
export type BookStatus = z.infer<typeof bookStatusSchema>;

export type BookLifecycle = BookStatus;

// These presentation buckets partition BOOK_STATUSES: every status must appear
// exactly once so per-bucket counts sum to the total.
export const LIBRARY_FILTER_BUCKETS = {
  wanted: ['wanted'],
  downloading: ['searching', 'downloading'],
  imported: ['importing', 'imported'],
  failed: ['failed'],
  missing: ['missing'],
} as const satisfies Record<string, readonly BookLifecycle[]>;

export type LibraryFilterBucket = keyof typeof LIBRARY_FILTER_BUCKETS;

export const LIBRARY_FILTER_BUCKET_KEYS = Object.keys(LIBRARY_FILTER_BUCKETS) as [LibraryFilterBucket, ...LibraryFilterBucket[]];

// The wire accepts bucket keys only; the client omits status for its `all` sentinel.
export const libraryStatusFilterSchema = z.enum(LIBRARY_FILTER_BUCKET_KEYS);

export const LIBRARY_FILTER_VALUES = ['all', ...LIBRARY_FILTER_BUCKET_KEYS] as const;
export type LibraryFilterValue = 'all' | LibraryFilterBucket;

export const ENRICHMENT_STATUSES = ['pending', 'enriched', 'failed', 'skipped', 'file-enriched'] as const;
export const enrichmentStatusSchema = z.enum(ENRICHMENT_STATUSES);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;

// Recording form, not part count (contentDeliveryType). Providers without format
// data use unknown. SQLite enum metadata is type-only; the alignment test guards drift.
export const PRODUCTION_TYPES = ['unabridged', 'abridged', 'full_cast', 'dramatized', 'graphic_audio', 'unknown'] as const;
export const productionTypeSchema = z.enum(PRODUCTION_TYPES);
export type ProductionType = z.infer<typeof productionTypeSchema>;

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
  subtitle: z.string().optional(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  coverUrl: z.string().optional(),
  // Trim before persistence so padded ASINs cannot split durable identity.
  asin: z.string().trim().optional(),
  isbn: z.string().optional(),
  seriesName: z.string().optional(),
  seriesPosition: z.number().optional(),
  duration: z.number().optional(),
  publishedDate: z.string().optional(),
  genres: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  searchImmediately: z.boolean().optional(),
  // Raw provider format string, normalized to a ProductionType by the add ladder. Nullish rather
  // than optional because providers report an absent format as null and `unknown` is a better
  // answer there than a 400.
  formatType: z.string().nullish(),
  // Transient request-only flag: overrides an undecided `review` verdict, never `same-recording`.
  // No column backs it; the created row must not record that a review was overridden.
  overrideRecordingReview: z.boolean().optional(),
}).strict();

// The POST /api/books 409 discriminator. Deliberately NOT a widening of recordingVerdictSchema:
// `owned-race` is a create-time ASIN collision reached after the resolver already said
// different-recording, and `different-recording` itself never produces a 409.
export const ADD_BOOK_CONFLICTS = ['same-recording', 'review', 'owned-race'] as const;
export const addBookConflictSchema = z.enum(ADD_BOOK_CONFLICTS);
export type AddBookConflict = z.infer<typeof addBookConflictSchema>;

// Required rather than optional: the batch never falls back to settings.quality, and the popover
// always derives an explicit boolean, so an omitted flag is a caller bug rather than "no search".
export const addAllSeriesBodySchema = z.object({
  searchImmediately: z.boolean(),
}).strict();
export type AddAllSeriesBody = z.infer<typeof addAllSeriesBodySchema>;

// Only these fields may be persisted in books.user_cleared_fields. Clearing
// seriesName also tombstones seriesPosition; seriesPosition may clear independently.
// SQLite does not enforce this domain, so the service write boundary must parse it.
export const CLEARABLE_BOOK_FIELDS = ['seriesName', 'seriesPosition', 'subtitle', 'description', 'publisher', 'publishedDate', 'genres'] as const;
export const clearableBookFieldSchema = z.enum(CLEARABLE_BOOK_FIELDS);
export type ClearableBookField = z.infer<typeof clearableBookFieldSchema>;
export const clearedFieldsSchema = z.array(clearableBookFieldSchema);

export const updateBookBodySchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').optional(),
  authors: z.array(bookAuthorInputSchema).min(1).optional(),
  narrators: z.array(z.string()).optional(),
  // Omitted means unchanged; null means clear. The service derives tombstones from
  // these values so enrichment cannot resurrect an operator-cleared field.
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  coverUrl: z.string().nullable().optional(),
  // Keep the raw year-or-date string. Clear genres with null, not [], because []
  // is a non-null override that blocks provider fallback in mergeBookData.
  publishedDate: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  status: bookStatusSchema.optional(),
  seriesName: z.string().nullable().optional(),
  seriesPosition: z.number().nullable().optional(),
}).strict();

// The server resolves replacement metadata from ASIN; clients must not supply it.
export const fixMatchRequestSchema = z.object({
  asin: z.string().trim().min(1, 'ASIN is required'),
  renameFiles: z.boolean().optional(),
  retagFiles: z.boolean().optional(),
}).strict();
export type FixMatchRequest = z.infer<typeof fixMatchRequestSchema>;

export const deleteBookQuerySchema = z.object({
  deleteFiles: z.string().optional(),
});

// track also controls trackTotal; seriesPart maps to seriesPosition.
// Keep this display order aligned with the preview modal's FIELD_ORDER.
export const RETAG_EXCLUDABLE_FIELDS = [
  'artist',
  'albumArtist',
  'album',
  'title',
  'composer',
  'grouping',
  'series',
  'seriesPart',
  'subtitle',
  'asin',
  'publisher',
  'description',
  'date',
  'genre',
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

// Query strings carry booleans as text; omission falls back to settings.
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
