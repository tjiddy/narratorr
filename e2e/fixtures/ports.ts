// The fake-service ports, single-sourced so the seed wrapper records the URLs globalSetup binds.
// A seeded indexer pointing at a port the fake never bound is a silent, run-wide search failure.

export const E2E_DEFAULT_PORTS = {
  mam: 4100,
  qbit: 4200,
  audible: 4300,
} as const;

/** Env overrides give parallel unit tests unique ports; the harness uses the fixed defaults above. */
export function resolvePort(envVar: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[envVar];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
