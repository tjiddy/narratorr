import { z } from 'zod';

// Keep discovery separate from stable /api/v1/system so older servers signal unsupported via 404.

// Do not reuse the defaulted setting: OpenAPI exposes shape, not owner configuration.
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
