import { z } from 'zod';

// ============================================================================
// Search schemas
// ============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(500),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  author: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
});

export const grabSchema = z.object({
  downloadUrl: z.string().min(1, 'Download URL is required'),
  title: z.string().min(1, 'Title is required'),
  protocol: z.enum(['torrent', 'usenet']).default('torrent'),
  bookId: z.number().int().positive().optional(),
  indexerId: z.number().int().positive().optional(),
  size: z.number().int().nonnegative().optional(),
  seeders: z.number().int().nonnegative().optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type GrabInput = z.infer<typeof grabSchema>;
