import type { z } from 'zod';

/**
 * Validate a persisted settings JSON blob through the per-type Zod schema.
 *
 * Entity services (notifier, indexer, download-client) store per-type adapter
 * settings as an opaque JSON column. On adapter construction this guard parses
 * the decrypted plaintext settings through the matching schema so a drifted row
 * (missing required field, hand-edited DB, legacy shape) surfaces as a clear
 * `ZodError` naming the offending field rather than a cryptic `undefined.split`
 * deep inside HTTP-call logic. It throws on shape mismatch and does not swallow.
 *
 * The `Unknown entity type` branch is an internal defensive guard: the calling
 * services perform their own per-type factory existence check first and throw a
 * service-specific message, so this branch is unreachable from those call sites.
 *
 * Type note: the existing `*SettingsSchemas` records are typed
 * `Record<EnumType, z.ZodTypeAny>` (i.e. `z.ZodType<any>`), so they can't carry
 * the narrow per-entity union through generic inference. Supply the entity's
 * settings union explicitly at the call site
 * (e.g. `parseEntitySettings<NotifierSettings>(...)`); the unavoidable cast from
 * the `ZodTypeAny` parse result is contained here, keeping the call sites narrow.
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
