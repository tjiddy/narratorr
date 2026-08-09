import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

export const seriesV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type SeriesV1 = z.infer<typeof seriesV1Schema>;

export const seriesV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type SeriesV1ListQuery = z.infer<typeof seriesV1ListQuerySchema>;

export interface SeriesV1Source {
  publicId: string;
  name: string;
}

export function toSeriesV1(row: SeriesV1Source): SeriesV1 {
  return { id: row.publicId, name: row.name };
}
