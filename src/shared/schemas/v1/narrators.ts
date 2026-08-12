import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

export const narratorV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type NarratorV1 = z.infer<typeof narratorV1Schema>;

export const narratorV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type NarratorV1ListQuery = z.infer<typeof narratorV1ListQuerySchema>;

export interface NarratorV1Source {
  publicId: string;
  name: string;
}

export function toNarratorV1(row: NarratorV1Source): NarratorV1 {
  return { id: row.publicId, name: row.name };
}
