import { describe, it, expect } from 'vitest';
import { companionEpubSettingsSchema, companionEpubFormSchema } from './companion-epub.js';
import { DEFAULT_SETTINGS, settingsRegistry } from './registry.js';

describe('companionEpubSettingsSchema', () => {
  it('parses an empty object to the disabled default', () => {
    expect(companionEpubSettingsSchema.parse({})).toEqual({ enabled: false });
  });

  it('accepts an explicit enabled: true', () => {
    expect(companionEpubSettingsSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });

  it('rejects a non-boolean enabled', () => {
    expect(companionEpubSettingsSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
});

describe('companionEpubFormSchema', () => {
  it('rejects an empty object — no default survives into the form schema', () => {
    expect(companionEpubFormSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an explicit boolean', () => {
    expect(companionEpubFormSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('has exactly the same top-level keys as the category schema', () => {
    expect(Object.keys(companionEpubFormSchema.shape).sort()).toEqual(
      Object.keys(companionEpubSettingsSchema.shape).sort(),
    );
  });
});

describe('registry wiring', () => {
  it('DEFAULT_SETTINGS.companionEpub and the registry defaults agree', () => {
    expect(DEFAULT_SETTINGS.companionEpub).toEqual({ enabled: false });
    expect(settingsRegistry.companionEpub.defaults).toEqual({ enabled: false });
  });

  it('registers no formSchema override (the pick-based form schema is consumed directly)', () => {
    expect(settingsRegistry.companionEpub.formSchema).toBeUndefined();
  });
});
