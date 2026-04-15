import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const systemSettingsSchema = z.object({
  backupIntervalMinutes: z.number().int().min(60).max(43200).default(10080),
  backupRetention: z.number().int().min(1).max(100).default(7),
  dismissedUpdateVersion: z.string().default(''),
});

// Form schema excludes dismissedUpdateVersion (managed by update-check UI, not
// the backup schedule form). Cast for zodResolver/z.infer compatibility.
export const systemFormSchema = stripDefaults(systemSettingsSchema).pick({
  backupIntervalMinutes: true,
  backupRetention: true,
}) as z.ZodObject<{
  backupIntervalMinutes: z.ZodNumber;
  backupRetention: z.ZodNumber;
}>;
