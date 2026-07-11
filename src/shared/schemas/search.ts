import { z } from 'zod';
import { protocolSchema } from './download-protocol.js';

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
  protocol: protocolSchema.default('torrent'),
  bookId: z.number().int().positive().optional(),
  indexerId: z.number().int().positive().optional(),
  size: z.number().int().nonnegative().optional(),
  seeders: z.number().int().nonnegative().optional(),
  guid: z.string().trim().min(1).optional(),
  // Search-time release infoHash (normalized identity field, #1857). Optional —
  // only torrent/magnet results carry one. Threaded so an internal replace request
  // carries the same identity fields (`guid` [+ indexerId], `infoHash`,
  // `downloadUrl`) the single-flight coalescing key consumes.
  infoHash: z.string().trim().min(1).optional(),
  isFreeleech: z.boolean().optional(),
  // Manual, user-confirmed "cancel the active download and grab this instead"
  // flow (#1857). Distinct, explicitly-added boolean — NOT the removed
  // auto-upgrade `replaceExisting` field (still rejected by `.strict()`).
  replace: z.boolean().optional().default(false),
}).strict();

/**
 * Route-body schema for `POST /api/search/grab` (#1857). Adds the cross-field
 * rule that `replace: true` requires a `bookId` — without one it silently
 * degenerates into an ordinary orphan grab (nothing to replace). Kept separate
 * from `grabSchema` so the base object schema keeps its `.shape` (the client's
 * `pickGrabFields` picker reads `grabSchema.shape`).
 */
export const grabBodySchema = grabSchema.superRefine((data, ctx) => {
  if (data.replace && data.bookId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'replace requires a bookId',
      path: ['replace'],
    });
  }
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type GrabInput = z.infer<typeof grabSchema>;
/** Pre-validation grab input — fields with `.default()` are optional. */
export type GrabPayload = z.input<typeof grabSchema>;
