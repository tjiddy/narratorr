import { describe, it, expect } from 'vitest';
import { earwitnessSettingsSchema, earwitnessFormSchema } from './earwitness.js';
import { settingsRegistry, DEFAULT_SETTINGS } from './registry.js';

describe('earwitnessSettingsSchema', () => {
  it('parses {} to the documented defaults (all .default() applied)', () => {
    expect(earwitnessSettingsSchema.parse({})).toEqual({ enabled: false, baseUrl: '', apiKey: '' });
  });

  it('accepts an explicit enabled + valid http(s) baseUrl + apiKey', () => {
    const result = earwitnessSettingsSchema.parse({
      enabled: true,
      baseUrl: 'https://earwitness.example.com',
      apiKey: 'sk-1234',
    });
    expect(result).toEqual({ enabled: true, baseUrl: 'https://earwitness.example.com', apiKey: 'sk-1234' });
  });

  it('normalizes baseUrl: trims surrounding whitespace and strips trailing slashes', () => {
    const result = earwitnessSettingsSchema.parse({ baseUrl: '  https://host:8080//  ' });
    expect(result.baseUrl).toBe('https://host:8080');
  });

  it('preserves a pathful baseUrl prefix (only trailing slash stripped)', () => {
    const result = earwitnessSettingsSchema.parse({ baseUrl: 'https://host/earwitness/' });
    expect(result.baseUrl).toBe('https://host/earwitness');
  });

  it('accepts an empty baseUrl (not configured / disabled)', () => {
    expect(earwitnessSettingsSchema.parse({ baseUrl: '' }).baseUrl).toBe('');
  });

  it('rejects a non-http(s) baseUrl scheme', () => {
    expect(earwitnessSettingsSchema.safeParse({ baseUrl: 'ftp://host' }).success).toBe(false);
  });

  it('rejects a malformed baseUrl', () => {
    expect(earwitnessSettingsSchema.safeParse({ baseUrl: 'not a url' }).success).toBe(false);
  });

  // baseUrl is intentionally NOT a registered secret, so the masked sentinel is
  // never submitted for it and must NOT be accepted as a valid value — it is just
  // an invalid URL. (apiKey, the only secret, accepts the sentinel as a plain
  // string for sentinel-preservation re-saves; see secret-codec resolveSentinelFields.)
  it('rejects the masked sentinel as a baseUrl (baseUrl is not a secret)', () => {
    expect(earwitnessSettingsSchema.safeParse({ baseUrl: '********' }).success).toBe(false);
  });

  it('accepts the sentinel as an apiKey (string passthrough for masked re-save)', () => {
    expect(earwitnessSettingsSchema.parse({ apiKey: '********' }).apiKey).toBe('********');
  });
});

describe('earwitness dual-default path', () => {
  it('registry defaults equal the schema defaults', () => {
    expect(settingsRegistry.earwitness.defaults).toEqual(earwitnessSettingsSchema.parse({}));
  });

  it('earwitness is present in DEFAULT_SETTINGS with the documented defaults', () => {
    expect(DEFAULT_SETTINGS.earwitness).toEqual({ enabled: false, baseUrl: '', apiKey: '' });
  });
});

describe('earwitnessFormSchema', () => {
  it('accepts a fully-provided form payload', () => {
    const result = earwitnessFormSchema.safeParse({ enabled: true, baseUrl: 'http://host:8080', apiKey: 'k' });
    expect(result.success).toBe(true);
  });

  it('has the same top-level keys as the category schema', () => {
    expect(Object.keys(earwitnessFormSchema.shape).sort()).toEqual(['apiKey', 'baseUrl', 'enabled']);
  });

  it('rejects an invalid baseUrl in the form', () => {
    expect(earwitnessFormSchema.safeParse({ enabled: false, baseUrl: 'nope', apiKey: '' }).success).toBe(false);
  });
});
