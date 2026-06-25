import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const discoverySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().int().min(1).max(168).default(24),
  maxSuggestionsPerAuthor: z.number().int().min(1).max(50).default(5),
  expiryDays: z.number().int().min(1).default(90),
});

// Form schema derived from discoverySettingsSchema via stripDefaults().
// Cast to typed ZodObject for zodResolver/z.infer compatibility (Zod v4 limitation:
// stripDefaults returns untyped shape; runtime behavior is correct).
export const discoveryFormSchema = stripDefaults(discoverySettingsSchema).pick({
  enabled: true,
  intervalHours: true,
  maxSuggestionsPerAuthor: true,
  expiryDays: true,
}) as z.ZodObject<{
  enabled: z.ZodBoolean;
  intervalHours: z.ZodNumber;
  maxSuggestionsPerAuthor: z.ZodNumber;
  expiryDays: z.ZodNumber;
}>;
