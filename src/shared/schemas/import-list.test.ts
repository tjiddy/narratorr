import { describe, expect, it } from 'vitest';
import {
  createImportListFormSchema,
  createImportListSchema,
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
  describe('positive cases — each type with valid settings', () => {
    it.todo('accepts valid abs settings (serverUrl + apiKey + libraryId)');
    it.todo('accepts valid nyt settings (apiKey)');
    it.todo('accepts valid hardcover settings (apiKey)');
  });

  describe('negative cases', () => {
    it.todo('rejects missing required fields for abs (no serverUrl)');
    it.todo('rejects extra unknown fields');
    it.todo('rejects wrong type discriminator');
  });

  describe('conditional validation', () => {
    it.todo('hardcover with listType shelf requires shelfId');
    it.todo('hardcover with listType trending does not require shelfId');
  });
});

describe('previewImportListSchema — typed settings validation', () => {
  it.todo('accepts valid preview with typed settings per provider');
  it.todo('rejects preview with invalid settings');
});

describe('updateImportListSchema — type required when settings present', () => {
  it.todo('accepts update with settings + type');
  it.todo('accepts update without settings (type not required)');
  it.todo('rejects update with settings but no type');
});
