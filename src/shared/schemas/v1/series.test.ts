import { describe, it, expect } from 'vitest';
import {
  seriesV1Schema,
  seriesV1ListQuerySchema,
  toSeriesV1,
} from './series.js';
import * as barrel from '../../schemas.js';

// A leaky source row carrying every internal series column: numeric rowid,
// normalizedName, hardcoverSeriesId, authorName, description, imageUrl,
// lastFetchedAt, timestamps. `toSeriesV1` must strip all of them.
function makeLeakyRow() {
  return {
    id: 7,
    publicId: 'sr_abc123',
    name: 'The Stormlight Archive',
    normalizedName: 'the stormlight archive',
    hardcoverSeriesId: 12345,
    authorName: 'Brandon Sanderson',
    description: 'Epic fantasy series',
    imageUrl: 'https://example.com/cover.jpg',
    lastFetchedAt: new Date('2024-01-01'),
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
  };
}

describe('toSeriesV1 projection (zero-leak)', () => {
  it('emits exactly { id, name } — no internal fields', () => {
    const dto = toSeriesV1(makeLeakyRow());
    expect(Object.keys(dto).sort()).toEqual(['id', 'name']);
  });

  it('maps id to the opaque publicId (string), not the numeric rowid', () => {
    const dto = toSeriesV1(makeLeakyRow());
    expect(dto.id).toBe('sr_abc123');
    expect(dto).toEqual({ id: 'sr_abc123', name: 'The Stormlight Archive' });
  });
});

describe('seriesV1Schema (fail-closed, .strict())', () => {
  const valid = { id: 'sr_1', name: 'The Stormlight Archive' };

  it('round-trips a projected DTO', () => {
    expect(seriesV1Schema.safeParse(valid).success).toBe(true);
  });

  it.each(['normalizedName', 'hardcoverSeriesId', 'authorName', 'description', 'imageUrl', 'lastFetchedAt'])(
    'rejects (does NOT strip) a leaked internal field (%s)',
    (field) => {
      const result = seriesV1Schema.safeParse({ ...valid, [field]: 'leak' });
      expect(result.success).toBe(false);
    },
  );
});

describe('seriesV1ListQuerySchema (composed, strict)', () => {
  it('accepts the documented params', () => {
    const result = seriesV1ListQuerySchema.safeParse({ limit: '50', offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('rejects unknown query params (cursor / snake_case sort_by)', () => {
    expect(seriesV1ListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(seriesV1ListQuerySchema.safeParse({ sort_by: 'name' }).success).toBe(false);
  });

  it('enforces pagination bounds', () => {
    expect(seriesV1ListQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
    expect(seriesV1ListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(seriesV1ListQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(seriesV1ListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

// F5 — barrel re-export contract.
describe('barrel re-export', () => {
  it('exposes seriesV1Schema and toSeriesV1 from the schemas barrel', () => {
    expect(barrel.seriesV1Schema).toBe(seriesV1Schema);
    expect(barrel.toSeriesV1).toBe(toSeriesV1);
    expect(barrel.seriesV1ListQuerySchema).toBe(seriesV1ListQuerySchema);
  });
});
