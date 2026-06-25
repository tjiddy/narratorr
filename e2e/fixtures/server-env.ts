import type { RunTempDirs } from './temp-dirs.js';

/**
 * Builds the production-bundle env for one E2E server. Lives in a side-effect-free
 * fixtures module (not `playwright.config.ts`) so a vitest unit test can import it
 * without triggering the config's module-load side effects (`createRunTempDirs()`
 * + `process.env` mutations).
 *
 * The servers differ only in their isolated temp-dir set, port, `URL_BASE`, and
 * whether auth is bypassed; everything else (fakes, monitor cadence) is shared.
 */
export interface ServerEnvOptions {
  /**
   * Inject `AUTH_BYPASS=true` (the default). The forms-auth server (#1555) passes
   * `false` so forms enforcement is genuinely active — the key omitted entirely,
   * not set falsy, because `config.ts` reads it as `=== 'true'`. With bypass on,
   * the login/redirect/logout assertions would be vacuous (every request just
   * succeeds), so the forms server MUST omit it.
   */
  authBypass?: boolean;
}

export function serverEnv(
  run: RunTempDirs,
  urlBase: string,
  port: number,
  options: ServerEnvOptions = {},
): Record<string, string> {
  const { authBypass = true } = options;

  const env: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: run.dbPath,
    CONFIG_PATH: run.configPath,
    URL_BASE: urlBase,
    // Poll every 2 seconds instead of the default 30 so the spec doesn't wait a
    // full minute for the monitor to notice the fake qBit's "complete" flip.
    MONITOR_INTERVAL_CRON: '*/2 * * * * *',
    // Surface the per-run downloads path for spec-side forensics/assertions.
    // Not consumed by app code — the fake qBit already knows the path from
    // its constructor in global-setup.ts.
    E2E_DOWNLOADS_PATH: run.downloadsPath,
    // Override the Audible API base URL so AudibleProvider sends requests to
    // the E2E fake instead of the real Audible API. The fake returns empty
    // products, making the match job resolve to confidence 'none'.
    AUDIBLE_BASE_URL: 'http://localhost:4300',
    // Surface the per-run source path for the manual-import spec. The spec
    // enters this path in the scan input so Narratorr discovers the seeded
    // audiobook folder.
    E2E_SOURCE_PATH: run.sourcePath,
  };

  // Only set the bypass key when requested — `config.ts` treats AUTH_BYPASS
  // as truthy only when literally 'true', but the forms server omits it entirely
  // so there is no chance of a stray value flipping the bypass on.
  if (authBypass) {
    env.AUTH_BYPASS = 'true';
  }

  return env;
}
