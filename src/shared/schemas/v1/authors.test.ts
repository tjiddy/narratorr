import { describe, it, expect } from 'vitest';
import {
  authorV1Schema,
  authorV1ListQuerySchema,
  toAuthorV1,
} from './authors.js';
import * as barrel from '../../schemas.js';

// A leaky source row carrying every internal author column: numeric rowid,
// slug, asin, timestamps. `toAuthorV1` must strip all of them.
function makeLeakyRow() {
  return {
    id: 42,
    publicId: 'au_abc123',
    name: 'Brandon Sanderson',
    slug: 'brandon-sanderson',
    asin: 'B00LEAK',
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
  };
}

describe('toAuthorV1 projection (zero-leak)', () => {
  it('emits exactly { id, name } — no internal fields', () => {
    const dto = toAuthorV1(makeLeakyRow());
    expect(Object.keys(dto).sort()).toEqual(['id', 'name']);
  });

  it('maps id to the opaque publicId (string), not the numeric rowid', () => {
    const dto = toAuthorV1(makeLeakyRow());
    expect(dto.id).toBe('au_abc123');
    expect(dto).toEqual({ id: 'au_abc123', name: 'Brandon Sanderson' });
  });
});

describe('authorV1Schema (fail-closed, .strict())', () => {
  const valid = { id: 'au_1', name: 'Hugh Howey' };

  it('round-trips a projected DTO', () => {
    expect(authorV1Schema.safeParse(valid).success).toBe(true);
  });

  it.each(['slug', 'asin', 'normalizedName', 'createdAt', 'id_numeric'])(
    'rejects (does NOT strip) a leaked internal field (%s)',
    (field) => {
      const result = authorV1Schema.safeParse({ ...valid, [field]: 'leak' });
      expect(result.success).toBe(false);
    },
  );
});

describe('authorV1ListQuerySchema (composed, strict)', () => {
  it('accepts the documented params', () => {
    const result = authorV1ListQuerySchema.safeParse({ limit: '50', offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('rejects unknown query params (cursor / snake_case sort_by)', () => {
    expect(authorV1ListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(authorV1ListQuerySchema.safeParse({ sort_by: 'name' }).success).toBe(false);
  });

  it('enforces pagination bounds', () => {
    expect(authorV1ListQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
    expect(authorV1ListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(authorV1ListQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(authorV1ListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

// F5 — the AC requires the new schema modules to be re-exported from the
// `src/shared/schemas.ts` barrel; consumers import from there, not the domain file.
describe('barrel re-export', () => {
  it('exposes authorV1Schema and toAuthorV1 from the schemas barrel', () => {
    expect(barrel.authorV1Schema).toBe(authorV1Schema);
    expect(barrel.toAuthorV1).toBe(toAuthorV1);
    expect(barrel.authorV1ListQuerySchema).toBe(authorV1ListQuerySchema);
  });
});
