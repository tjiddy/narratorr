import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  v1ErrorEnvelopeSchema,
  v1PaginationParamsSchema,
  v1ListResponseSchema,
} from './common.js';
import * as barrel from '../../schemas.js';

describe('shared schemas barrel re-export', () => {
  // Guards the downstream consumer contract: the v1 building blocks must be
  // reachable through `src/shared/schemas.ts`, not only via the local module.
  // Deleting the `export * from './schemas/v1/common.js'` barrel line would
  // fail these assertions.
  it('exposes the v1 building blocks through the shared barrel as the same objects', () => {
    expect(barrel.v1ErrorEnvelopeSchema).toBe(v1ErrorEnvelopeSchema);
    expect(barrel.v1PaginationParamsSchema).toBe(v1PaginationParamsSchema);
    expect(barrel.v1ListResponseSchema).toBe(v1ListResponseSchema);
  });
});

describe('v1ErrorEnvelopeSchema', () => {
  it('accepts the object form { error: { code, message } }', () => {
    const result = v1ErrorEnvelopeSchema.safeParse({
      error: { code: 'NOT_FOUND', message: 'Book not found' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.code).toBe('NOT_FOUND');
      expect(result.data.error.message).toBe('Book not found');
    }
  });

  it('rejects the bare-string form { error: "x" } — shape is locked to the object form', () => {
    const result = v1ErrorEnvelopeSchema.safeParse({ error: 'boom' });
    expect(result.success).toBe(false);
  });

  it('rejects an envelope missing code', () => {
    const result = v1ErrorEnvelopeSchema.safeParse({ error: { message: 'x' } });
    expect(result.success).toBe(false);
  });

  it('rejects an envelope missing message', () => {
    const result = v1ErrorEnvelopeSchema.safeParse({ error: { code: 'X' } });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside the error object (.strict)', () => {
    const result = v1ErrorEnvelopeSchema.safeParse({
      error: { code: 'X', message: 'y', detail: 'extra' },
    });
    expect(result.success).toBe(false);
  });
});

describe('v1PaginationParamsSchema', () => {
  // Behavioral contract (not object identity): the building block enforces
  // limit/offset bounds and, per the v1 ADR (common.ts:36-40), stays a
  // NON-strict building block so it can be composed with filter/sort params
  // before strictness is applied at the composed level.
  it('honors limit min/max bounds (1–500)', () => {
    expect(v1PaginationParamsSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(v1PaginationParamsSchema.safeParse({ limit: 500 }).success).toBe(true);
    expect(v1PaginationParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(v1PaginationParamsSchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it('honors offset >= 0', () => {
    expect(v1PaginationParamsSchema.safeParse({ offset: 0 }).success).toBe(true);
    expect(v1PaginationParamsSchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('allows omitting both params', () => {
    expect(v1PaginationParamsSchema.safeParse({}).success).toBe(true);
  });

  it('is a NON-strict building block — strips unknown keys rather than rejecting (strictness belongs at the composed level)', () => {
    const result = v1PaginationParamsSchema.safeParse({ limit: 10, unknown: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('unknown' in result.data).toBe(false);
    }
  });

  it('rejects unknown keys once composed-and-strict (the pattern v1 list validators use)', () => {
    // Mirrors how `bookV1ListQuerySchema` is built: extend the non-strict
    // pagination block with filter/sort params, then `.strict()` the union so
    // unknown params (e.g. a snake_case `sort_by`) are rejected, not stripped.
    const composed = v1PaginationParamsSchema
      .extend({ author: z.string().optional() })
      .strict();
    expect(composed.safeParse({ limit: 10, author: 'a' }).success).toBe(true);
    expect(composed.safeParse({ limit: 10, sort_by: 'title' }).success).toBe(false);
  });
});

describe('v1ListResponseSchema', () => {
  const schema = v1ListResponseSchema(z.object({ id: z.number() }));

  it('validates { data: [...], total: N }', () => {
    const result = schema.safeParse({ data: [{ id: 1 }, { id: 2 }], total: 2 });
    expect(result.success).toBe(true);
  });

  it('validates an empty data array with total 0', () => {
    const result = schema.safeParse({ data: [], total: 0 });
    expect(result.success).toBe(true);
  });

  it('rejects a bare array', () => {
    const result = schema.safeParse([{ id: 1 }]);
    expect(result.success).toBe(false);
  });

  it('requires total', () => {
    const result = schema.safeParse({ data: [{ id: 1 }] });
    expect(result.success).toBe(false);
  });

  it('rejects negative total', () => {
    const result = schema.safeParse({ data: [], total: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects items that do not match the item schema', () => {
    const result = schema.safeParse({ data: [{ id: 'x' }], total: 1 });
    expect(result.success).toBe(false);
  });
});
