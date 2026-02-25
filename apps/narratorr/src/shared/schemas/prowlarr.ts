import { z } from 'zod';

// ============================================================================
// Prowlarr schemas
// ============================================================================

export const prowlarrSyncModeSchema = z.enum(['addOnly', 'fullSync']);

export const prowlarrConfigSchema = z.object({
  url: z.string().min(1, 'Prowlarr URL is required').url('Must be a valid URL'),
  apiKey: z.string().min(1, 'API key is required'),
  syncMode: prowlarrSyncModeSchema.default('addOnly'),
  categories: z.array(z.number().int()).default([3030]),
});

export type ProwlarrConfigInput = z.infer<typeof prowlarrConfigSchema>;

export const prowlarrTestSchema = z.object({
  url: z.string().min(1, 'Prowlarr URL is required'),
  apiKey: z.string().min(1, 'API key is required'),
});

export const prowlarrSyncApplySchema = z.object({
  items: z.array(z.object({
    prowlarrId: z.number().int(),
    action: z.enum(['new', 'updated', 'unchanged', 'removed']),
    selected: z.boolean(),
  })),
});

export type ProwlarrSyncApplyInput = z.infer<typeof prowlarrSyncApplySchema>;
