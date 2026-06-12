import { z } from 'zod';

const VALID_PROXY_SCHEMES = ['http:', 'https:', 'socks5:'];
const SENTINEL = '********';

export const networkSettingsSchema = z.object({
  proxyUrl: z.string().default('').transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (trimmed === SENTINEL) return SENTINEL; // Passthrough sentinel for masked values
    // Strip trailing slash
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true; // empty is valid (proxy disabled)
      if (val === SENTINEL) return true; // sentinel passthrough for masked values
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});

// Page form schema for NetworkSettingsSection. Identical proxyUrl validation to
// networkSettingsSchema but without the `.default('')` (forms always supply an
// explicit value via defaultValues). Relocated from the page module so
// registry.test.ts can guard it (#1388). It is 1:1 with the `network` category
// today, but an unguarded single-field page is exactly where a future-added
// `network` field would silently fail to appear. Shape unchanged.
export const networkFormSchema = z.object({
  proxyUrl: z.string().transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (trimmed === SENTINEL) return SENTINEL; // Passthrough sentinel for masked values
    // Strip trailing slash
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true; // empty is valid (proxy disabled)
      if (val === SENTINEL) return true; // sentinel passthrough for masked values
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});
