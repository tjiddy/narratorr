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
