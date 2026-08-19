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

/**
 * The `{ error }` body `plugins/error-handler.ts` sends for every error in its registry. Deliberately
 * NOT registered as a route response schema: the handler is the only producer of these bodies, so a
 * per-route registration pins nothing a test can red. It is the oracle route tests assert against.
 */
export const apiErrorResponseSchema = z.object({
  error: z.string(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

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
