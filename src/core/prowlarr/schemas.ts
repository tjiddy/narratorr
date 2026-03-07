import { z } from 'zod';

const prowlarrCategorySchema: z.ZodType<{ id: number; name: string; subCategories?: unknown[] }> = z.object({
  id: z.number(),
  name: z.string(),
  subCategories: z.array(z.lazy(() => prowlarrCategorySchema)).optional(),
}).passthrough();

export const prowlarrIndexerSchema = z.object({
  id: z.number(),
  name: z.string(),
  protocol: z.enum(['torrent', 'usenet']),
  fields: z.array(z.object({ name: z.string(), value: z.unknown() }).passthrough()),
  capabilities: z.object({
    categories: z.array(prowlarrCategorySchema).nullable().optional(),
  }).nullable().optional(),
  enable: z.boolean(),
}).passthrough();

export const prowlarrIndexersResponseSchema = z.array(prowlarrIndexerSchema);
