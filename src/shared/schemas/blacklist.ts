import { z } from 'zod';

// ============================================================================
// Blacklist schemas
// ============================================================================

export const blacklistReasonSchema = z.enum(['wrong_content', 'bad_quality', 'wrong_narrator', 'spam', 'other']);

export const createBlacklistSchema = z.object({
  infoHash: z.string().min(1, 'Info hash is required'),
  title: z.string().min(1, 'Title is required'),
  bookId: z.number().int().optional(),
  reason: blacklistReasonSchema.optional(),
  note: z.string().max(500).optional(),
});

export type CreateBlacklistInput = z.infer<typeof createBlacklistSchema>;
