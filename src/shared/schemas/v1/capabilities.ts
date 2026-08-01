import { z } from 'zod';

// ============================================================================
// Public API v1 — Capabilities (#1961, plan §8)
// ============================================================================
//
// Feature-discovery for third-party consumers. `/api/v1/system` is a documented
// stable five-field build/version contract and stays untouched — capability
// discovery lives here, at its own endpoint, so an older Narratorr answers the
// probe with a plain `404` ("feature unsupported") instead of a system payload
// missing a key.

/**
 * `GET /api/v1/capabilities` response. `.strict()` at BOTH levels per the v1
 * owned-schema convention (`compat-surface-zod-strip-not-strict`'s inverse) — an
 * unexpected key fails serialization rather than being silently shipped.
 *
 * `enabled` is declared FRESH here as a bare `z.boolean()`. It must NOT reuse
 * `companionEpubSettingsSchema` (`src/shared/schemas/settings/companion-epub.ts`),
 * whose `enabled` carries `.default(false)`: that default would be emitted into
 * the public OpenAPI document, publishing a value-shaped hint about the owner's
 * configuration. Only the capability SHAPE is public; the value is per-request.
 */
export const capabilitiesV1Schema = z
  .object({
    companionEpub: z
      .object({
        enabled: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CapabilitiesV1 = z.infer<typeof capabilitiesV1Schema>;
