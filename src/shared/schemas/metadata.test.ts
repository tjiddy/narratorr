import { describe, expect, it } from 'vitest';
import { metadataSearchQuerySchema, providerIdParamSchema } from './metadata.js';

describe('metadataSearchQuerySchema — trim behavior', () => {
  it('rejects whitespace-only query', () => {
    const result = metadataSearchQuerySchema.safeParse({ q: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from query', () => {
    const result = metadataSearchQuerySchema.safeParse({ q: '  tolkien  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('tolkien');
  });

  it('accepts valid query', () => {
    const result = metadataSearchQuerySchema.safeParse({ q: 'tolkien' });
    expect(result.success).toBe(true);
  });
});

describe('providerIdParamSchema — trim behavior', () => {
  it('rejects whitespace-only id', () => {
    const result = providerIdParamSchema.safeParse({ id: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from id', () => {
    const result = providerIdParamSchema.safeParse({ id: '  audible  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe('audible');
  });

  it('accepts valid id', () => {
    const result = providerIdParamSchema.safeParse({ id: 'audible' });
    expect(result.success).toBe(true);
  });
});
