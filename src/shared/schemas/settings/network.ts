import { z } from 'zod';

const VALID_PROXY_SCHEMES = ['http:', 'https:', 'socks5:'];

export const networkSettingsSchema = z.object({
  proxyUrl: z.string().default('').transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    // Strip trailing slash
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true; // empty is valid (proxy disabled)
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});
