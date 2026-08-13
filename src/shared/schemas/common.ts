import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.string().transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ID',
      });
      return z.NEVER;
    }
    return parsed;
  }),
});

export const DEFAULT_LIMITS = {
  books: 120,
  blacklist: 100,
  importListExclusions: 100,
  activity: 50,
  eventHistory: 50,
} as const;

export const paginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
}
