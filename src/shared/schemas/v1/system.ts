import { z } from 'zod';

// Strictness blocks internal system fields; plain strings permit dev/unknown build values.
export const systemV1Schema = z
  .object({
    version: z.string(),
    commit: z.string(),
    buildTime: z.string(),
    nodeVersion: z.string(),
    os: z.string(),
  })
  .strict();

export type SystemV1 = z.infer<typeof systemV1Schema>;
