import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodError } from './format-zod-error.js';

describe('formatZodError', () => {
  it('formats a nested object path as dotted segments', () => {
    const schema = z.object({ results: z.object({ books: z.object({ title: z.string() }) }) });
    const parsed = schema.safeParse({ results: { books: { title: 42 } } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatZodError(parsed.error)).toMatch(/^results\.books\.title: /);
  });

  it('formats an array-index path with the numeric segment', () => {
    const schema = z.object({ books: z.array(z.object({ title: z.string() })) });
    const parsed = schema.safeParse({ books: [{ title: 'ok' }, { title: 99 }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatZodError(parsed.error)).toMatch(/^books\.1\.title: /);
  });

  it('emits only the message with no leading ": " for a top-level (empty-path) failure', () => {
    const schema = z.object({ ok: z.string() });
    const parsed = schema.safeParse('not-an-object');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const formatted = formatZodError(parsed.error);
    expect(formatted).not.toMatch(/^: /);
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('falls back to "unknown" when the issue has no message', () => {
    const error = { issues: [{ path: [], message: undefined }] } as unknown as z.ZodError;
    expect(formatZodError(error)).toBe('unknown');
  });
});
