import { z } from 'zod';

export const AuthorRefSchema = z.object({
  name: z.string().trim().min(1),
  asin: z.string().optional(),
});

export const SeriesRefSchema = z.object({
  name: z.string(),
  position: z.number().optional(),
  asin: z.string().optional(),
});

export const BookMetadataSchema = z.object({
  asin: z.string().optional(),
  alternateAsins: z.array(z.string()).optional(),
  isbn: z.string().optional(),
  goodreadsId: z.string().optional(),
  providerId: z.string().optional(),
  title: z.string().trim().min(1),
  subtitle: z.string().optional(),
  authors: z.array(AuthorRefSchema).min(1),
  narrators: z.array(z.string()).optional(),
  series: z.array(SeriesRefSchema).optional(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  publishedDate: z.string().optional(),
  language: z.string().optional(),
  coverUrl: z.string().url().optional(),
  duration: z.number().optional(),
  genres: z.array(z.string()).optional(),
  relevance: z.number().optional(),
});

export const AuthorMetadataSchema = z.object({
  asin: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  genres: z.array(z.string()).optional(),
  relevance: z.number().optional(),
});

export const SeriesMetadataSchema = z.object({
  asin: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  books: z.array(BookMetadataSchema),
});

export const MetadataSearchResultsSchema = z.object({
  books: z.array(BookMetadataSchema),
  authors: z.array(AuthorMetadataSchema),
  series: z.array(SeriesMetadataSchema),
  warnings: z.array(z.string()).optional(),
});
