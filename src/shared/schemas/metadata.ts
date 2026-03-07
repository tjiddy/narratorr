import { z } from 'zod';

// ============================================================================
// Metadata schemas
// ============================================================================

export const metadataSearchQuerySchema = z.object({
  q: z.string().min(1, 'Query is required').max(500),
});

export const providerIdParamSchema = z.object({
  id: z.string().min(1, 'Provider ID is required'),
});

export type MetadataSearchQuery = z.infer<typeof metadataSearchQuerySchema>;
