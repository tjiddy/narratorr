import { z } from 'zod';

// ============================================================================
// Blacklist schemas
// ============================================================================

export const blacklistReasonSchema = z.enum(['wrong_content', 'bad_quality', 'wrong_narrator', 'spam', 'other', 'download_failed', 'infrastructure_error']);

export const blacklistTypeSchema = z.enum(['temporary', 'permanent']);

export const createBlacklistSchema = z.object({
  infoHash: z.string().min(1, 'Info hash is required'),
  title: z.string().min(1, 'Title is required'),
  bookId: z.number().int().optional(),
  reason: blacklistReasonSchema,
  note: z.string().max(500).optional(),
  blacklistType: blacklistTypeSchema.optional(),
});

export const toggleBlacklistTypeSchema = z.object({
  blacklistType: blacklistTypeSchema,
});

export type BlacklistReason = z.infer<typeof blacklistReasonSchema>;
export type BlacklistType = z.infer<typeof blacklistTypeSchema>;
export type CreateBlacklistInput = z.infer<typeof createBlacklistSchema>;
