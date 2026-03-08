import { describe, it, expect } from 'vitest';
import { networkSettingsSchema } from './network.js';

describe('networkSettingsSchema', () => {
  describe('proxyUrl validation', () => {
    it('accepts http:// proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'http://gluetun:8888' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('http://gluetun:8888');
    });

    it('accepts https:// proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'https://proxy.local:3128' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('https://proxy.local:3128');
    });

    it('accepts socks5:// proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'socks5://localhost:1080' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('socks5://localhost:1080');
    });

    it('rejects ftp:// proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'ftp://proxy:21' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid URL string', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'not-a-url' });
      expect(result.success).toBe(false);
    });

    it('accepts empty string (proxy disabled)', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: '' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('');
    });

    it('trims whitespace from proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: '  http://proxy:8888  ' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('http://proxy:8888');
    });

    it('accepts proxy URL with authentication credentials', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'http://user:pass@proxy:8888' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('http://user:pass@proxy:8888');
    });

    it('strips trailing slash from proxy URL', () => {
      const result = networkSettingsSchema.safeParse({ proxyUrl: 'http://proxy:8888/' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('http://proxy:8888');
    });
  });

  describe('defaults', () => {
    it('defaults proxyUrl to empty string', () => {
      const result = networkSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.proxyUrl).toBe('');
    });
  });
});
