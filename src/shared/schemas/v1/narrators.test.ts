import { describe, it, expect } from 'vitest';
import {
  narratorV1Schema,
  narratorV1ListQuerySchema,
  toNarratorV1,
} from './narrators.js';
import * as barrel from '../../schemas.js';

// A leaky source row carrying every internal narrator column: numeric rowid,
// slug, timestamps. `toNarratorV1` must strip all of them.
function makeLeakyRow() {
  return {
    id: 9,
    publicId: 'nr_abc123',
    name: 'Kate Reading',
    slug: 'kate-reading',
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
  };
}

describe('toNarratorV1 projection (zero-leak)', () => {
  it('emits exactly { id, name } — no internal fields', () => {
    const dto = toNarratorV1(makeLeakyRow());
    expect(Object.keys(dto).sort()).toEqual(['id', 'name']);
  });

  it('maps id to the opaque publicId (string), not the numeric rowid', () => {
    const dto = toNarratorV1(makeLeakyRow());
    expect(dto.id).toBe('nr_abc123');
    expect(dto).toEqual({ id: 'nr_abc123', name: 'Kate Reading' });
  });
});

describe('narratorV1Schema (fail-closed, .strict())', () => {
  const valid = { id: 'nr_1', name: 'Kate Reading' };

  it('round-trips a projected DTO', () => {
    expect(narratorV1Schema.safeParse(valid).success).toBe(true);
  });

  it.each(['slug', 'createdAt', 'updatedAt', 'id_numeric'])(
    'rejects (does NOT strip) a leaked internal field (%s)',
    (field) => {
      const result = narratorV1Schema.safeParse({ ...valid, [field]: 'leak' });
      expect(result.success).toBe(false);
    },
  );
});

describe('narratorV1ListQuerySchema (composed, strict)', () => {
  it('accepts the documented params', () => {
    const result = narratorV1ListQuerySchema.safeParse({ limit: '50', offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('rejects unknown query params (cursor / snake_case sort_by)', () => {
    expect(narratorV1ListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(narratorV1ListQuerySchema.safeParse({ sort_by: 'name' }).success).toBe(false);
  });

  it('enforces pagination bounds', () => {
    expect(narratorV1ListQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
    expect(narratorV1ListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(narratorV1ListQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(narratorV1ListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

// F5 — barrel re-export contract.
describe('barrel re-export', () => {
  it('exposes narratorV1Schema and toNarratorV1 from the schemas barrel', () => {
    expect(barrel.narratorV1Schema).toBe(narratorV1Schema);
    expect(barrel.toNarratorV1).toBe(toNarratorV1);
    expect(barrel.narratorV1ListQuerySchema).toBe(narratorV1ListQuerySchema);
  });
});
