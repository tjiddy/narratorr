import { z } from 'zod';

const VALID_PROXY_SCHEMES = ['http:', 'https:', 'socks5:'];
const SENTINEL = '********';

export const networkSettingsSchema = z.object({
  proxyUrl: z.string().default('').transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (trimmed === SENTINEL) return SENTINEL; // Preserve the stored secret when masked values round-trip.
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true;
      if (val === SENTINEL) return true;
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});

// Forms supply explicit values, so this mirrors networkSettingsSchema without its default.
export const networkFormSchema = z.object({
  proxyUrl: z.string().transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (trimmed === SENTINEL) return SENTINEL;
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true;
      if (val === SENTINEL) return true;
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});
