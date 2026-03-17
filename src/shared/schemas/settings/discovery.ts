import { z } from 'zod';
import { SUGGESTION_REASONS } from '../discovery.js';

const multiplierField = z.number().min(0).max(1).default(1);

const weightMultipliersSchema = z.object(
  Object.fromEntries(SUGGESTION_REASONS.map((r) => [r, multiplierField])) as Record<string, typeof multiplierField>,
);

export const discoverySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  intervalHours: z.number().int().min(1).max(168).default(24),
  maxSuggestionsPerAuthor: z.number().int().min(1).max(50).default(5),
  expiryDays: z.number().int().min(1).default(90),
  snoozeDays: z.number().int().min(1).default(30),
  weightMultipliers: weightMultipliersSchema.default(
    Object.fromEntries(SUGGESTION_REASONS.map((r) => [r, 1])) as Record<string, number>,
  ),
});
