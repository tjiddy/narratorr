import { z } from 'zod';
import {
  bookStatusSchema,
  bookSortFieldSchema,
  bookSortDirectionSchema,
  type BookStatus,
} from '../book.js';
import { v1PaginationParamsSchema, v1ErrorEnvelopeSchema } from './common.js';
import { companionEbookV1Schema, type CompanionEbookV1 } from './companion-ebook.js';

export const bookV1PersonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

// Book rows expose denormalized series data here, not a series public ID.
export const bookV1SeriesSchema = z
  .object({
    name: z.string(),
    position: z.number().nullable(),
  })
  .strict()
  .nullable();

export const bookV1Schema = z
  .object({
    id: z.string(),
    title: z.string(),
    authors: z.array(bookV1PersonSchema),
    narrators: z.array(bookV1PersonSchema),
    series: bookV1SeriesSchema,
    status: bookStatusSchema,
    companionEbook: companionEbookV1Schema,
  })
  .strict();

export type BookV1 = z.infer<typeof bookV1Schema>;

// Apply strictness after extension; a strict pagination base would reject these filter/sort keys.
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

// Trim before min so blank ASINs fail before duplicate and provider lookups.
export const createBookV1RequestSchema = z
  .object({
    asin: z.string().trim().min(1, 'ASIN is required'),
  })
  .strict();

export type CreateBookV1Request = z.infer<typeof createBookV1RequestSchema>;

// existingId lets a lost-response retry find the book created by the first request.
export const bookExistsV1Schema = v1ErrorEnvelopeSchema
  .extend({
    existingId: z.string(),
  })
  .strict();

export type BookExistsV1 = z.infer<typeof bookExistsV1Schema>;

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
 * `companionEbook` arrives already mapped. Never pass this directly to Array.map:
 * the array index would become the second argument.
 */
export function toBookV1(row: BookV1Source, companionEbook: CompanionEbookV1 | null): BookV1 {
  return {
    id: row.publicId,
    title: row.title,
    authors: row.authors.map((a) => ({ id: a.publicId, name: a.name })),
    narrators: row.narrators.map((n) => ({ id: n.publicId, name: n.name })),
    series: row.seriesName
      ? { name: row.seriesName, position: row.seriesPosition ?? null }
      : null,
    status: row.status,
    companionEbook,
  };
}
