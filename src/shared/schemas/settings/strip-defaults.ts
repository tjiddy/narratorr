import { z } from 'zod';

/**
 * Strips `.default()` wrappers from all fields of a Zod object schema.
 * Produces a form-ready schema where all fields require explicit values.
 *
 * Note: Zod v4's internal types prevent a fully generic return type.
 * The runtime behavior is correct (defaults are removed), but callers
 * that need precise z.infer<> types should cast the result or use
 * the typed .pick() overloads on the returned schema.
 */
export function stripDefaults(schema: z.ZodObject<z.ZodRawShape>) {
  const newShape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    // Zod v4: shape entries are $ZodType (internal), cast for public ZodType compat
    newShape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as never;
  }
  return z.object(newShape);
}
