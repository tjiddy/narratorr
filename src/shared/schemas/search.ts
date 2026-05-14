import { z } from 'zod';

// ============================================================================
// Search schemas
// ============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(500),
  // `?limit=` (empty string) and an omitted `limit` both default to 50.
  // `z.coerce.number()` would coerce '' to 0 and reject it; explicit transform
  // preserves the empty-string default while rejecting NaN/decimal/out-of-range.
  limit: z
    .string()
    .optional()
    .transform((val, ctx): number => {
      if (val === undefined || val === '') return 50;
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'limit must be an integer between 1 and 500',
        });
        return z.NEVER;
      }
      return n;
    }),
  author: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
  bookDuration: z.string().optional().transform((val) => {
    if (!val) return undefined;
    const num = Number(val);
    if (Number.isNaN(num) || num <= 0) return null; // signal invalid
    return num;
  }),
});

export const grabSchema = z.object({
  downloadUrl: z.string().trim().min(1, 'Download URL is required'),
  title: z.string().trim().min(1, 'Title is required'),
  protocol: z.enum(['torrent', 'usenet']).default('torrent'),
  bookId: z.number().int().positive().optional(),
  indexerId: z.number().int().positive().optional(),
  size: z.number().int().nonnegative().optional(),
  seeders: z.number().int().nonnegative().optional(),
  guid: z.string().trim().min(1).optional(),
}).strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type GrabInput = z.infer<typeof grabSchema>;
/** Pre-validation grab input — fields with `.default()` are optional. */
export type GrabPayload = z.input<typeof grabSchema>;
