import { z } from 'zod';

/**
 * Removes field defaults for forms that require explicit values. Zod v4 erases
 * the precise object shape here, so callers cast when they need exact inference.
 */
export function stripDefaults(schema: z.ZodObject<z.ZodRawShape>) {
  const newShape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    newShape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as never;
  }
  return z.object(newShape);
}
