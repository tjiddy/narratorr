import { z } from 'zod';

// ============================================================================
// Book schemas
// ============================================================================

export const BOOK_STATUSES = ['wanted', 'searching', 'downloading', 'importing', 'imported', 'missing', 'failed'] as const;
export const bookStatusSchema = z.enum(BOOK_STATUSES);
export type BookStatus = z.infer<typeof bookStatusSchema>;

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
  monitorForUpgrades: z.boolean().optional(),
  searchImmediately: z.boolean().optional(),
});

export const updateBookBodySchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').optional(),
  authors: z.array(bookAuthorInputSchema).min(1).optional(),
  narrators: z.array(z.string()).optional(),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  status: bookStatusSchema.optional(),
  seriesName: z.string().nullable().optional(),
  seriesPosition: z.number().nullable().optional(),
  monitorForUpgrades: z.boolean().optional(),
});

export const deleteBookQuerySchema = z.object({
  deleteFiles: z.string().optional(),
});

export type BookAuthorInput = z.infer<typeof bookAuthorInputSchema>;
export type BookListQuery = z.infer<typeof bookListQuerySchema>;
export type CreateBookBody = z.infer<typeof createBookBodySchema>;
export type UpdateBookBody = z.infer<typeof updateBookBodySchema>;
export type DeleteBookQuery = z.infer<typeof deleteBookQuerySchema>;
