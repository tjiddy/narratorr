import { z } from 'zod';

// ============================================================================
// Enrichment schemas
// ============================================================================

export const enrichmentStatusSchema = z.enum(['pending', 'enriched', 'failed', 'skipped', 'file-enriched']);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;
