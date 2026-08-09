import type { z } from 'zod';

/**
 * Validate decrypted adapter settings at construction so drift fails with a field-specific
 * ZodError. Callers supply `T` because `ZodTypeAny` maps cannot infer the entity union.
 */
export function parseEntitySettings<T>(
  schemas: Record<string, z.ZodTypeAny>,
  type: string,
  settings: Record<string, unknown>,
): T {
  const schema = schemas[type];
  if (!schema) throw new Error(`Unknown entity type: ${type}`);
  return schema.parse(settings) as T;
}
