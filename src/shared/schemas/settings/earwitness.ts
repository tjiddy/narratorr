import { z } from 'zod';

const VALID_SCHEMES = ['http:', 'https:'];

// baseUrl is intentionally NOT a registered secret (see SECRET_FIELDS in
// secret-codec.ts). Unlike the connector precedent (#1491) — where baseUrl can
// carry embedded credentials and is masked — earwitness authenticates purely via
// the `X-Api-Key` header, so the base URL is not credential-shaped. Keeping it
// in plaintext means the operator can see/verify the configured host, and the
// Test-Connection route never has to resolve a sentinel `baseUrl`. Only `apiKey`
// is encrypted at rest and masked in responses.
function isValidBaseUrl(val: string): boolean {
  if (!val) return true; // empty is valid (earwitness disabled / not yet configured)
  try {
    return VALID_SCHEMES.includes(new URL(val).protocol);
  } catch {
    return false;
  }
}

const BASE_URL_MSG = 'Must be a valid http(s) URL';

export const earwitnessSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z
    .string()
    .default('')
    .transform((val) => val.trim().replace(/\/+$/, '')) // normalize: trim + strip trailing slash
    .pipe(z.string().refine(isValidBaseUrl, { message: BASE_URL_MSG })),
  apiKey: z.string().default(''),
});

// Page form schema for EarwitnessSettings. Surfaces all three category fields.
// `.default()` is omitted (forms always supply explicit defaultValues), and the
// baseUrl validator uses a plain `.refine()` (no `.transform()`) so input and
// output types stay aligned for zodResolver (see CLAUDE.md "Zod + zodResolver
// type divergence"). apiKey is a plain string so the masked '********' sentinel
// passes through on re-save without editing.
export const earwitnessFormSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().refine(isValidBaseUrl, { message: BASE_URL_MSG }),
  apiKey: z.string(),
});
