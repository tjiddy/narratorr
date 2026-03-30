import { z } from 'zod';

/**
 * Strips `.default()` wrappers from all fields of a Zod object schema.
 * Produces a form-ready schema where all fields require explicit values.
 */
export function stripDefaults(schema: z.ZodObject<z.ZodRawShape>) {
  const newShape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    // Zod v4: shape entries are $ZodType (internal), cast for public ZodType compat
    newShape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as never;
  }
  return z.object(newShape);
}
