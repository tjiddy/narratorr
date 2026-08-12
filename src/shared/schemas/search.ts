import { z } from 'zod';
import { protocolSchema } from './download-protocol.js';

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(500),
  // Empty and omitted both mean 50; explicit parsing avoids z.coerce.number('') === 0.
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
    if (Number.isNaN(num) || num <= 0) return null; // null distinguishes invalid from omitted
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
  // Torrent-only identity used with guid/indexerId/downloadUrl for single-flight deduplication.
  infoHash: z.string().trim().min(1).optional(),
  isFreeleech: z.boolean().optional(),
  // Explicit user-confirmed replacement, never automatic upgrade behavior.
  replace: z.boolean().optional().default(false),
}).strict();

// Keep this cross-field rule separate: client pickGrabFields reads grabSchema.shape.
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
// Pre-validation type: defaulted fields remain optional.
export type GrabPayload = z.input<typeof grabSchema>;
