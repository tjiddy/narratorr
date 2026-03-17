import { z } from 'zod';

const weightMultipliersSchema = z.object({
  author: z.number().min(0).max(1).default(1),
  series: z.number().min(0).max(1).default(1),
  genre: z.number().min(0).max(1).default(1),
  narrator: z.number().min(0).max(1).default(1),
  diversity: z.number().min(0).max(1).default(1),
});

export const discoverySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  intervalHours: z.number().int().min(1).max(168).default(24),
  maxSuggestionsPerAuthor: z.number().int().min(1).max(50).default(5),
  expiryDays: z.number().int().min(1).default(90),
  snoozeDays: z.number().int().min(1).default(30),
  weightMultipliers: weightMultipliersSchema.default({ author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 }),
});
