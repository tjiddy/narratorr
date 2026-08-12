import { z } from 'zod';
import { paginationParamsSchema } from '../common.js';

// Native v1 owns its contracts: complete schemas stay strict so unknown or leaked fields fail.
export const v1ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export type V1ErrorEnvelope = z.infer<typeof v1ErrorEnvelopeSchema>;

// Trim before min so encoded whitespace IDs fail validation instead of becoming not-found lookups.
export const v1PublicIdParamSchema = z.object({ publicId: z.string().trim().min(1) }).strict();

export type V1PublicIdParam = z.infer<typeof v1PublicIdParamSchema>;

// Alias the shared limit/offset schema; callers extend it before applying strictness.
export const v1PaginationParamsSchema = paginationParamsSchema;

export type V1PaginationParams = z.infer<typeof v1PaginationParamsSchema>;

export function v1ListResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      data: z.array(itemSchema),
      total: z.number().int().min(0),
    })
    .strict();
}

export interface V1ListResponse<T> {
  data: T[];
  total: number;
}
