import { z } from 'zod';

// ============================================================================
// Public API v1 — System (build/version info — #1709)
// ============================================================================
//
// The public contract for `GET /api/v1/system`: a singleton resource exposing
// ONLY narratorr's build/version info to API-key-authenticated consumers
// (dashboard widgets, monitoring, homelab tooling).
//
// `.strict()` is load-bearing and fail-closed: it deliberately mirrors the other
// native v1 schemas narratorr OWNS (the OPPOSITE of the prowlarr-compat surface,
// which stays `.strip()` — learning `compat-surface-zod-strip-not-strict`). It is
// what GUARANTEES the sensitive `/api/system/info` fields (`libraryPath`,
// `freeSpace`, `dbSize`) can NEVER leak onto this endpoint: any extra key fails
// serialization rather than being silently stripped and shipped.
//
// Plain `z.string()` (no format constraint) is also load-bearing: `commit` and
// `buildTime` resolve to the literal `"unknown"` fallback when the build env is
// unset, and `version` may be `"dev"` — a stricter format (e.g. semver/datetime)
// would reject those legitimate values.

/**
 * The public System DTO. Exposes EXACTLY the five build/version fields:
 * `{ version, commit, buildTime, nodeVersion, os }`. `.strict()` rejects any
 * additional key at serialization, fail-closed against an internal-field leak.
 * This is a STABLE contract — a breaking change would require `/api/v2/`.
 */
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
