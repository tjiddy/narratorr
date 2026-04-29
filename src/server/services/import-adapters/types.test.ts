import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  manualImportJobPayloadSchema,
  autoImportJobPayloadSchema,
  type ManualImportJobPayload,
  type AutoImportJobPayload,
} from './types.js';
import type { BookMetadata } from '../../../core/metadata/index.js';

describe('manualImportJobPayloadSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = manualImportJobPayloadSchema.safeParse({
      path: '/audiobooks/Author/Title',
      title: 'Test Book',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional mode of copy/move', () => {
    expect(manualImportJobPayloadSchema.safeParse({
      path: '/p', title: 't', mode: 'copy',
    }).success).toBe(true);
    expect(manualImportJobPayloadSchema.safeParse({
      path: '/p', title: 't', mode: 'move',
    }).success).toBe(true);
  });

  it('rejects missing required path', () => {
    const result = manualImportJobPayloadSchema.safeParse({ title: 'Test Book' });
    expect(result.success).toBe(false);
  });

  it('rejects missing required title', () => {
    const result = manualImportJobPayloadSchema.safeParse({ path: '/p' });
    expect(result.success).toBe(false);
  });

  it('preserves `metadata` typing as BookMetadata | undefined (type-only override)', () => {
    expectTypeOf<ManualImportJobPayload['metadata']>().toEqualTypeOf<BookMetadata | undefined>();
  });
});

describe('autoImportJobPayloadSchema', () => {
  it('accepts { downloadId: number }', () => {
    const result = autoImportJobPayloadSchema.safeParse({ downloadId: 42 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.downloadId).toBe(42);
  });

  it('rejects missing downloadId', () => {
    expect(autoImportJobPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-numeric downloadId', () => {
    expect(autoImportJobPayloadSchema.safeParse({ downloadId: 'abc' }).success).toBe(false);
  });

  it('inferred type is { downloadId: number }', () => {
    expectTypeOf<AutoImportJobPayload>().toEqualTypeOf<{ downloadId: number }>();
  });
});
