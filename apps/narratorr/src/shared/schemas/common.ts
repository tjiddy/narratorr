import { z } from 'zod';

// ============================================================================
// Common schemas
// ============================================================================

export const idParamSchema = z.object({
  id: z.string().transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ID',
      });
      return z.NEVER;
    }
    return parsed;
  }),
});
