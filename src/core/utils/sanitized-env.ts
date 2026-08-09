// Never spread process.env into child processes: it contains encryption and database secrets.
// Keep this Node-only helper out of the Vite-facing barrel and import it directly.
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
