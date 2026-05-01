// User-script env vector. Spreading process.env would leak secrets like
// NARRATORR_SECRET_KEY (the AES-256-GCM key for at-rest encryption) and
// DATABASE_URL into scripts that don't need them. This allowlist exposes only
// the keys a typical script needs to find binaries, write tempfiles, and
// produce localized output.
//
// Not re-exported from ./index.ts on purpose — that barrel is consumed by the
// Vite client build, which excludes Node-only modules. Import this helper by
// path from both server- and core-side call sites.
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TZ',
]);

export function sanitizedEnv(
  extras: Record<string, string | undefined> = {},
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}
