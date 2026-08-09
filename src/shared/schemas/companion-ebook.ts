import { z } from 'zod';

// none and ambiguous are discovery outcomes, not EPUB validation results.
// The companion_ebooks CHECK constraint is generated from this tuple.
export const COMPANION_EBOOK_STATUSES = [
  'available', 'none', 'ambiguous', 'invalid', 'drm_protected',
] as const;

export const companionEbookStatusSchema = z.enum(COMPANION_EBOOK_STATUSES);

export type CompanionEbookStatus = z.infer<typeof companionEbookStatusSchema>;
