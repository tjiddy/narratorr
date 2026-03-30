import { z } from 'zod';
import { SUGGESTION_REASONS } from '../discovery.js';
import { stripDefaults } from './strip-defaults.js';

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

// Form schema derived from discoverySettingsSchema via stripDefaults(), excluding
// weightMultipliers — it's computed by DiscoveryService during refreshes, not
// editable in the Discovery settings form.
// Cast to typed ZodObject for zodResolver/z.infer compatibility (Zod v4 limitation:
// stripDefaults returns untyped shape; runtime behavior is correct).
export const discoveryFormSchema = stripDefaults(discoverySettingsSchema).pick({
  enabled: true,
  intervalHours: true,
  maxSuggestionsPerAuthor: true,
  expiryDays: true,
  snoozeDays: true,
}) as z.ZodObject<{
  enabled: z.ZodBoolean;
  intervalHours: z.ZodNumber;
  maxSuggestionsPerAuthor: z.ZodNumber;
  expiryDays: z.ZodNumber;
  snoozeDays: z.ZodNumber;
}>;
