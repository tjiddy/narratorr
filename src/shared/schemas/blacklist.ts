import { z } from 'zod';

// ============================================================================
// Blacklist schemas
// ============================================================================

export const BLACKLIST_REASONS = [
  'wrong_content', 'bad_quality', 'wrong_narrator', 'spam',
  'other', 'download_failed', 'infrastructure_error', 'user_cancelled',
] as const;

export type BlacklistReason = typeof BLACKLIST_REASONS[number];

export const REASON_LABELS: Record<string, string> = {
  wrong_content: 'Wrong Content',
  bad_quality: 'Bad Quality',
  wrong_narrator: 'Wrong Narrator',
  spam: 'Spam',
  other: 'Other',
  download_failed: 'Download Failed',
  infrastructure_error: 'Infrastructure Error',
  user_cancelled: 'User Cancelled',
} satisfies Record<BlacklistReason, string>;

export const blacklistReasonSchema = z.enum(BLACKLIST_REASONS);

export const blacklistTypeSchema = z.enum(['temporary', 'permanent']);

export const createBlacklistSchema = z.object({
  infoHash: z.string().trim().min(1).optional(),
  guid: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1, 'Title is required'),
  bookId: z.number().int().optional(),
  reason: blacklistReasonSchema,
  note: z.string().max(500).optional(),
  blacklistType: blacklistTypeSchema.optional(),
}).superRefine((data, ctx) => {
  if (!data.infoHash && !data.guid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one identifier (infoHash or guid) is required',
      path: ['infoHash'],
    });
  }
});

export const toggleBlacklistTypeSchema = z.object({
  blacklistType: blacklistTypeSchema,
});

export type BlacklistType = z.infer<typeof blacklistTypeSchema>;
export type CreateBlacklistInput = z.infer<typeof createBlacklistSchema>;
