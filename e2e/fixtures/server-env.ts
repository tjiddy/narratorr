import type { RunTempDirs } from './temp-dirs.js';

// Side-effect-free so unit tests can import it without Playwright config allocating temp dirs.
export interface ServerEnvOptions {
  /** Defaults true; forms auth passes false so the key is omitted and its assertions remain meaningful. */
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
    // Poll every 2s so completion specs do not wait for the 30s production cadence.
    MONITOR_INTERVAL_CRON: '*/2 * * * * *',
    // Spec-only handoff; app code does not consume this value.
    E2E_DOWNLOADS_PATH: run.downloadsPath,
    // Keep Audible requests offline and force deterministic no-match confidence.
    AUDIBLE_BASE_URL: 'http://localhost:4300',
    // Spec-only manual-import scan source.
    E2E_SOURCE_PATH: run.sourcePath,
  };

  if (authBypass) {
    env.AUTH_BYPASS = 'true';
  }

  return env;
}
