import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseEntitySettings } from './parse-entity-settings.js';

const fooSchema = z.object({ host: z.string().trim().min(1), port: z.number().int() });
const schemas: Record<string, z.ZodTypeAny> = { foo: fooSchema };

describe('parseEntitySettings', () => {
  it('returns the validated settings for a known type', () => {
    const settings = parseEntitySettings(schemas, 'foo', { host: 'localhost', port: 8080 });
    expect(settings).toEqual({ host: 'localhost', port: 8080 });
  });

  it('throws a ZodError naming the offending field on shape mismatch', () => {
    expect(() => parseEntitySettings(schemas, 'foo', { port: 8080 })).toThrow(/host/);
  });

  it('throws "Unknown entity type" for a type absent from the schema record (internal guard)', () => {
    expect(() => parseEntitySettings(schemas, 'bar', {})).toThrow('Unknown entity type: bar');
  });
});
