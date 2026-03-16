import { z } from 'zod';

export const discoverySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  intervalHours: z.number().int().min(1).max(168).default(24),
  maxSuggestionsPerAuthor: z.number().int().min(1).max(50).default(5),
});
