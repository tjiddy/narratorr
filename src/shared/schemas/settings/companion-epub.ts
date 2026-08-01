import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

/**
 * Companion-ebook feature flag (#1958, plan §1). `companionEpub` is internal
 * vocabulary: it reaches the API response and the form payload, but never a
 * rendered label — the owner-facing surface is the "Ebooks" settings section.
 */
export const companionEpubSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

// Form schema derived from companionEpubSettingsSchema via stripDefaults().
// Cast to typed ZodObject for zodResolver/z.infer compatibility (Zod v4 limitation:
// stripDefaults returns untyped shape; runtime behavior is correct).
export const companionEpubFormSchema = stripDefaults(companionEpubSettingsSchema).pick({
  enabled: true,
}) as z.ZodObject<{
  enabled: z.ZodBoolean;
}>;
