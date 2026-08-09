import { z } from 'zod';
import { v1PaginationParamsSchema } from './common.js';

export const authorV1Schema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export type AuthorV1 = z.infer<typeof authorV1Schema>;

export const authorV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type AuthorV1ListQuery = z.infer<typeof authorV1ListQuerySchema>;

export interface AuthorV1Source {
  publicId: string;
  name: string;
}

export function toAuthorV1(row: AuthorV1Source): AuthorV1 {
  return { id: row.publicId, name: row.name };
}
