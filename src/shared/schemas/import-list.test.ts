import { describe, expect, it } from 'vitest';
import {
  absSettingsSchema,
  createImportListFormSchema,
  createImportListSchema,
  hardcoverSettingsSchema,
  previewImportListSchema,
  updateImportListSchema,
} from './import-list.js';

const validBase = {
  name: 'My List',
  type: 'nyt' as const,
  settings: { apiKey: 'key123' },
};

describe('createImportListSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createImportListSchema.safeParse({ ...validBase, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createImportListSchema.safeParse({ ...validBase, name: '  My List  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My List');
  });

  it('accepts valid name', () => {
    const result = createImportListSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});

describe('updateImportListSchema — trim behavior', () => {
  it('rejects whitespace-only name when provided', () => {
    const result = updateImportListSchema.safeParse({ name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name when provided', () => {
    const result = updateImportListSchema.safeParse({ name: '  My List  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My List');
  });
});

describe('createImportListFormSchema — trim behavior', () => {
  const validForm = {
    name: 'My List',
    type: 'nyt' as const,
    enabled: true,
    syncIntervalMinutes: 1440,
    settings: { apiKey: 'key123' },
  };

  it('rejects whitespace-only name', () => {
    const result = createImportListFormSchema.safeParse({ ...validForm, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createImportListFormSchema.safeParse({ ...validForm, name: '  My List  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My List');
  });
});

// #557 — Typed adapter settings schemas (discriminated unions)
describe('createImportListSchema — typed settings validation', () => {
  const base = { name: 'Test' };

  describe('positive cases — each type with valid settings', () => {
    it('accepts valid abs settings (serverUrl + apiKey + libraryId)', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib1' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid nyt settings (apiKey)', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'nyt', settings: { apiKey: 'nytkey' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid hardcover settings (apiKey)', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'hardcover', settings: { apiKey: 'hckey' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('negative cases', () => {
    it('rejects missing required fields for abs (no serverUrl)', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'abs', settings: { apiKey: 'key', libraryId: 'lib' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ['settings', 'serverUrl'] }),
        );
      }
    });

    it('rejects extra unknown fields', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'nyt', settings: { apiKey: 'key', badField: true },
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string for required field', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'nyt', settings: { apiKey: '' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('conditional validation', () => {
    it('hardcover with listType shelf requires shelfId', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'hardcover', settings: { apiKey: 'key', listType: 'shelf' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ['settings', 'shelfId'] }),
        );
      }
    });

    it('hardcover with listType trending does not require shelfId', () => {
      const result = createImportListSchema.safeParse({
        ...base, type: 'hardcover', settings: { apiKey: 'key', listType: 'trending' },
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('createImportListSchema — invalid discriminant rejection', () => {
  it('rejects unknown type value with z.enum error on the type field', () => {
    const result = createImportListSchema.safeParse({
      name: 'Bad List',
      type: 'badList',
      settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib1' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['type'] }),
      );
    }
  });
});

describe('previewImportListSchema — typed settings validation', () => {
  it('accepts valid preview with typed settings per provider', () => {
    const result = previewImportListSchema.safeParse({
      type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects preview with invalid settings', () => {
    const result = previewImportListSchema.safeParse({
      type: 'abs', settings: { apiKey: 'key' },
    });
    expect(result.success).toBe(false);
  });
});

// #732 — Hardcover shelfId numeric tightening (parameterize GraphQL injection fix)
describe('hardcoverSettingsSchema — numeric shelfId (#732)', () => {
  it('rejects non-numeric shelfId', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf', shelfId: 'not-a-number' });
    expect(result.success).toBe(false);
  });

  it('coerces numeric string shelfId to number', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf', shelfId: '42' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shelfId).toBe(42);
  });

  it('rejects zero shelfId', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf', shelfId: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative shelfId', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf', shelfId: -1 });
    expect(result.success).toBe(false);
  });

  it('still requires shelfId via superRefine when listType is shelf', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['shelfId'] }),
      );
    }
  });

  it('rejects GraphQL injection payload at the schema layer', () => {
    const injection = '1 } } ) { id email } #';
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'shelf', shelfId: injection });
    expect(result.success).toBe(false);
  });

  it('parses default trending settings cleanly without shelfId', () => {
    const result = hardcoverSettingsSchema.safeParse({ apiKey: 'k', listType: 'trending' });
    expect(result.success).toBe(true);
  });

  it('coerces numeric string shelfId end-to-end through createImportListSchema', () => {
    const result = createImportListSchema.safeParse({
      name: 'x', type: 'hardcover', settings: { apiKey: 'k', listType: 'shelf', shelfId: '42' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.settings as { shelfId?: number }).shelfId).toBe(42);
    }
  });
});

// #786 — ABS libraryId URL-path injection tightening
describe('absSettingsSchema libraryId (#786)', () => {
  const baseSettings = { serverUrl: 'http://abs.local', apiKey: 'key' };

  describe('rejects path-injection payloads', () => {
    const injections = [
      '../../../etc/passwd',
      'lib-1/../sensitive',
      'lib%2F1',
      'lib 1',
      'lib?id=1',
      'lib#frag',
      'lib\\1',
      'lib.1.2',
    ];
    for (const libraryId of injections) {
      it(`rejects ${JSON.stringify(libraryId)}`, () => {
        const result = absSettingsSchema.safeParse({ ...baseSettings, libraryId });
        expect(result.success).toBe(false);
      });
    }
  });

  describe('rejects whitespace-only and empty', () => {
    it('rejects empty string', () => {
      const result = absSettingsSchema.safeParse({ ...baseSettings, libraryId: '' });
      expect(result.success).toBe(false);
    });

    it('rejects whitespace-only', () => {
      const result = absSettingsSchema.safeParse({ ...baseSettings, libraryId: '   ' });
      expect(result.success).toBe(false);
    });
  });

  describe('accepts canonical ABS library ID shapes', () => {
    const accepted = [
      'lib_o78uaoeuh78h6',
      '550e8400-e29b-41d4-a716-446655440000',
      'lib-1',
      'library_123',
    ];
    for (const libraryId of accepted) {
      it(`accepts ${JSON.stringify(libraryId)}`, () => {
        const result = absSettingsSchema.safeParse({ ...baseSettings, libraryId });
        expect(result.success).toBe(true);
      });
    }
  });

  it('rejects URL-path injection payload at the schema layer', () => {
    const injection = '../../../etc/passwd';
    const result = absSettingsSchema.safeParse({ ...baseSettings, libraryId: injection });
    expect(result.success).toBe(false);
  });
});

// #786 — Form-schema libraryId regex coverage (F1)
describe('createImportListFormSchema libraryId (#786)', () => {
  const validForm = {
    name: 'My ABS',
    type: 'abs' as const,
    enabled: true,
    syncIntervalMinutes: 1440,
  };

  it('rejects path-injection libraryId in ABS form settings', () => {
    const result = createImportListFormSchema.safeParse({
      ...validForm,
      settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: '../../../etc/passwd' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['settings', 'libraryId'] }),
      );
    }
  });

  it('accepts canonical ABS libraryId in form settings', () => {
    const result = createImportListFormSchema.safeParse({
      ...validForm,
      settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib_o78uaoeuh78h6' },
    });
    expect(result.success).toBe(true);
  });

  it('trims surrounding whitespace on ABS libraryId before regex validation', () => {
    const result = createImportListFormSchema.safeParse({
      ...validForm,
      settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: '  lib-1  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.libraryId).toBe('lib-1');
    }
  });
});

describe('updateImportListSchema — type required when settings present', () => {
  it('accepts update with settings + type', () => {
    const result = updateImportListSchema.safeParse({
      type: 'nyt' as const, settings: { apiKey: 'newkey' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts update without settings (type not required)', () => {
    const result = updateImportListSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('rejects update with settings but no type', () => {
    const result = updateImportListSchema.safeParse({
      settings: { apiKey: 'key' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['type'], message: 'Type is required when settings are provided' }),
      );
    }
  });
});
