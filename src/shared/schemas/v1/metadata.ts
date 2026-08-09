import { z } from 'zod';
import { bookStatusSchema } from '../book.js';
import { pickPrimarySeries } from '../../pick-primary-series.js';
import { companionEbookV1Schema } from './companion-ebook.js';

// Provider results are pre-library data: they use ASINs and names, not library public IDs.
export const metadataSearchResultV1AuthorSchema = z
  .object({
    name: z.string(),
    asin: z.string().optional(),
  })
  .strict();

export const metadataSearchResultV1NarratorSchema = z
  .object({
    name: z.string(),
  })
  .strict();

export const metadataSearchResultV1SeriesSchema = z
  .object({
    name: z.string(),
    position: z.number().optional(),
  })
  .strict();

// `library` is a best-effort route annotation added after projection; lookup failures leave it absent.
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
        // Required when library exists; null means no exposed ebook, not an old server.
        companionEbook: companionEbookV1Schema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type MetadataSearchResultV1 = z.infer<typeof metadataSearchResultV1Schema>;

// Keep the 500-character bound aligned with internal metadataSearchQuerySchema.
export const metadataSearchV1QuerySchema = z
  .object({
    q: z.string().trim().min(1, 'Query is required').max(500),
  })
  .strict();

export type MetadataSearchV1Query = z.infer<typeof metadataSearchV1QuerySchema>;

// Structural input avoids core imports; coverUrl is renamed and pickPrimarySeries selects one series.
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

// Conditional spreads satisfy exactOptionalPropertyTypes; the narrators field always emits an array.
export function toMetadataSearchResultV1(
  source: MetadataSearchResultV1Source,
): MetadataSearchResultV1 {
  const series = pickPrimarySeries(source);
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
