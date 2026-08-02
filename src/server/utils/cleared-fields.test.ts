import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  parseClearedFields,
  serializeClearedFields,
  normalizeClearedFieldsColumn,
  recomputeClearedFields,
} from './cleared-fields.js';
import { CLEARABLE_BOOK_FIELDS } from '@shared/schemas/book.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/**
 * The longest run of `raw` that V8's `JSON.parse` SyntaxError message quotes back.
 * The engine echoes a bounded window around the failure point (roughly ten
 * characters, elided with `...`), so tests assert against the fragment it actually
 * leaked instead of a hand-picked sentinel that may fall outside that window.
 * Returns `''` when the message is purely positional.
 */
function longestEchoedFragment(raw: string): string {
  let message = '';
  try {
    JSON.parse(raw);
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  let longest = '';
  for (let start = 0; start < raw.length; start++) {
    for (let end = raw.length; end > start + longest.length; end--) {
      const candidate = raw.slice(start, end);
      if (message.includes(candidate)) {
        longest = candidate;
        break;
      }
    }
  }
  return longest;
}

describe('parseClearedFields', () => {
  it('parses SQL NULL and a legacy "[]" to the empty set without warning', () => {
    const log = createMockLogger();
    expect(parseClearedFields(null, log, 1)).toEqual([]);
    expect(parseClearedFields('[]', log, 1)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns the recognized names for a valid array', () => {
    const log = createMockLogger();
    expect(parseClearedFields('["genres","seriesName"]', log, 1)).toEqual(['genres', 'seriesName']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('degrades unparseable JSON to the empty set with one warn and no raw value', () => {
    const log = createMockLogger();
    expect(parseClearedFields('{oops', log, 42)).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual(expect.objectContaining({ bookId: 42 }));
    expect(JSON.stringify(payload)).not.toContain('{oops');
  });

  // AC4's no-raw rule is ABSOLUTE, and `{oops` is the one shape that cannot catch a
  // violation: V8 reports it positionally ("Expected property name or '}' in JSON at
  // position 1") and never echoes the source. Most malformed input DOES echo a
  // window of it — `JSON.parse('{"a": bad}')` yields
  // `Unexpected token 'b', "{"a": bad}" is not valid JSON` — so a
  // `serializeError(err)` payload reproduces persisted content verbatim in logs.
  it.each([
    ['object with a bare token', '{"seriesName": bad}'],
    ['array with a bare token', '["seriesName", bad]'],
    ['bare identifier', 'notjson-sentinel-abc123'],
    ['single-quoted string', "'quoted-sentinel'"],
    ['array with a dangling comma', '["seriesName",]'],
    ['long value truncated to V8\'s echo window', '{"seriesName": operator-typed-secret-value-here}'],
  ])('never reproduces the stored value in the warn payload (%s)', (_label, raw) => {
    // Derive the fragment V8 ACTUALLY echoed rather than guessing one: the engine
    // quotes a bounded window around the failure point, so a hard-coded sentinel
    // longer than that window makes the test pass for the wrong reason.
    const echoed = longestEchoedFragment(raw);
    // Premise guard — if V8 ever stops echoing, this case proves nothing and should
    // say so loudly rather than going quietly green.
    expect(echoed.length).toBeGreaterThanOrEqual(4);

    const log = createMockLogger();
    expect(parseClearedFields(raw, log, 7)).toEqual([]);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    // Assert on the WHOLE serialized payload, not just known keys — a nested
    // `error.message`/`error.stack` is exactly how the value used to escape.
    expect(JSON.stringify(payload)).not.toContain(echoed);
    expect(message).not.toContain(echoed);
    expect(payload).toEqual({ bookId: 7 });
  });

  it('carries no error object at all on the unparseable arm', () => {
    const log = createMockLogger();
    parseClearedFields('{"a": bad}', log, 3);
    const [payload] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).not.toHaveProperty('error');
    expect(Object.keys(payload)).toEqual(['bookId']);
  });

  it('degrades a JSON object to the empty set with one warn carrying only bookId', () => {
    const log = createMockLogger();
    expect(parseClearedFields('{"seriesName":true,"leaked":"SHAPE_SENTINEL"}', log, 7)).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual({ bookId: 7 });
    expect(JSON.stringify(payload)).not.toContain('SHAPE_SENTINEL');
  });

  it('degrades an array of numbers to the empty set with one warn', () => {
    const log = createMockLogger();
    expect(parseClearedFields('[1,2]', log, 7)).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('drops unknown names, keeps the recognized ones, and warns naming the drops', () => {
    const log = createMockLogger();
    expect(parseClearedFields('["genres","futureField"]', log, 9)).toEqual(['genres']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ bookId: 9, dropped: ['futureField'] }),
    );
  });

  it('sanitizes a non-canonical stored value (unsorted + duplicated)', () => {
    const log = createMockLogger();
    expect(parseClearedFields('["subtitle","genres","subtitle"]', log, 1)).toEqual(['genres', 'subtitle']);
  });

  it('never throws for any of the malformed shapes', () => {
    const log = createMockLogger();
    for (const raw of ['{oops', '"a string"', '3', 'null', '[null]', '[{"a":1}]']) {
      expect(() => parseClearedFields(raw, log, 1)).not.toThrow();
    }
  });
});

describe('serializeClearedFields', () => {
  it('emits the canonical sorted, deduplicated form', () => {
    expect(serializeClearedFields(['subtitle', 'genres', 'subtitle'])).toBe('["genres","subtitle"]');
  });

  it('stores the empty set as SQL NULL, never "[]"', () => {
    expect(serializeClearedFields([])).toBeNull();
  });

  it('accepts every canonical clearable name', () => {
    expect(() => serializeClearedFields([...CLEARABLE_BOOK_FIELDS])).not.toThrow();
    expect(serializeClearedFields([...CLEARABLE_BOOK_FIELDS])).toBe(
      JSON.stringify([...CLEARABLE_BOOK_FIELDS].sort()),
    );
  });

  it('throws on an unknown field name', () => {
    expect(() => serializeClearedFields(['genres', 'futureField'])).toThrow();
  });
});

describe('normalizeClearedFieldsColumn', () => {
  it('canonicalizes a valid raw column value', () => {
    expect(normalizeClearedFieldsColumn('["subtitle","genres"]')).toBe('["genres","subtitle"]');
  });

  it('maps null/undefined and the empty array to SQL NULL', () => {
    expect(normalizeClearedFieldsColumn(null)).toBeNull();
    expect(normalizeClearedFieldsColumn(undefined)).toBeNull();
    expect(normalizeClearedFieldsColumn('[]')).toBeNull();
  });

  it('throws on unparseable JSON and on an unknown name', () => {
    expect(() => normalizeClearedFieldsColumn('{oops')).toThrow();
    expect(() => normalizeClearedFieldsColumn('["futureField"]')).toThrow();
  });
});

describe('recomputeClearedFields — AC6 matrix, string fields', () => {
  const STRING_FIELDS = ['seriesName', 'subtitle', 'description', 'publisher', 'publishedDate'] as const;

  for (const field of STRING_FIELDS) {
    it(`${field}: absent key leaves the set and the stored value untouched`, () => {
      const r = recomputeClearedFields([], {});
      expect(r.cleared).toEqual([]);
      expect(r.normalized).toEqual({});
      expect(r.blanked).toEqual([]);
    });

    it(`${field}: null adds the tombstone and normalizes the stored value to NULL`, () => {
      const r = recomputeClearedFields([], { [field]: null });
      expect(r.cleared).toEqual([field]);
      expect(r.normalized[field]).toBeNull();
      expect(r.blanked).toEqual([field]);
    });

    it(`${field}: '' adds the tombstone and normalizes the stored value to NULL`, () => {
      const r = recomputeClearedFields([], { [field]: '' });
      expect(r.cleared).toEqual([field]);
      expect(r.normalized[field]).toBeNull();
    });

    it(`${field}: whitespace-only adds the tombstone and normalizes the stored value to NULL`, () => {
      const r = recomputeClearedFields([], { [field]: '   ' });
      expect(r.cleared).toEqual([field]);
      expect(r.normalized[field]).toBeNull();
    });

    it(`${field}: a non-blank value removes the tombstone and stores verbatim`, () => {
      const r = recomputeClearedFields([field], { [field]: '  Mistborn  ' });
      expect(r.cleared).toEqual([]);
      expect(r.normalized[field]).toBe('  Mistborn  ');
      expect(r.blanked).toEqual([]);
    });
  }

  it('preserves interior whitespace on description (matches diffDescription)', () => {
    const r = recomputeClearedFields([], { description: 'one\n\n  two' });
    expect(r.normalized.description).toBe('one\n\n  two');
  });
});

describe('recomputeClearedFields — AC6 matrix, genres', () => {
  it('absent key leaves the set untouched', () => {
    expect(recomputeClearedFields(['genres'], {}).cleared).toEqual(['genres']);
  });

  it('null adds the tombstone and stores NULL', () => {
    const r = recomputeClearedFields([], { genres: null });
    expect(r.cleared).toEqual(['genres']);
    expect(r.normalized.genres).toBeNull();
    expect(r.blanked).toEqual(['genres']);
  });

  it('[] adds the tombstone and stores NULL', () => {
    const r = recomputeClearedFields([], { genres: [] });
    expect(r.cleared).toEqual(['genres']);
    expect(r.normalized.genres).toBeNull();
  });

  it("['', '  '] adds the tombstone and stores NULL", () => {
    const r = recomputeClearedFields([], { genres: ['', '  '] });
    expect(r.cleared).toEqual(['genres']);
    expect(r.normalized.genres).toBeNull();
  });

  it('a mixed array removes the tombstone and drops the blank elements', () => {
    const r = recomputeClearedFields(['genres'], { genres: ['Fantasy', '  ', 'Epic'] });
    expect(r.cleared).toEqual([]);
    expect(r.normalized.genres).toEqual(['Fantasy', 'Epic']);
  });
});

describe('recomputeClearedFields — pair rule and non-clearable keys', () => {
  it('seriesPosition: null alone never adds a tombstone', () => {
    const r = recomputeClearedFields([], { seriesPosition: null });
    expect(r.cleared).toEqual([]);
    expect(r.normalized).toEqual({});
  });

  it('seriesName: null covers the pair — only seriesName is tombstoned', () => {
    const r = recomputeClearedFields([], { seriesName: null, seriesPosition: null });
    expect(r.cleared).toEqual(['seriesName']);
    expect(r.normalized).toEqual({ seriesName: null });
  });

  it('non-clearable keys never affect the set', () => {
    const r = recomputeClearedFields([], {
      coverUrl: null, status: 'wanted', title: 'x', narrators: [], authors: [{ name: 'a' }],
    });
    expect(r.cleared).toEqual([]);
    expect(r.normalized).toEqual({});
    expect(r.blanked).toEqual([]);
  });
});

describe('recomputeClearedFields — idempotence and canonical form', () => {
  it('applying the same clear twice yields a one-element set', () => {
    const once = recomputeClearedFields([], { seriesName: null });
    const twice = recomputeClearedFields(once.cleared, { seriesName: null });
    expect(twice.cleared).toEqual(['seriesName']);
  });

  it('output is sorted and deduplicated, and the empty set serializes to NULL not "[]"', () => {
    const r = recomputeClearedFields(['subtitle', 'subtitle', 'publisher'] as never, { genres: null });
    expect(r.cleared).toEqual(['genres', 'publisher', 'subtitle']);
    expect(serializeClearedFields(r.cleared)).toBe('["genres","publisher","subtitle"]');
    expect(serializeClearedFields(recomputeClearedFields(['genres'], { genres: ['Fantasy'] }).cleared)).toBeNull();
  });

  it('mixed body: one field blanked while another is set in the same call', () => {
    const r = recomputeClearedFields(['publisher'], { seriesName: null, publisher: 'Tor' });
    expect(r.cleared).toEqual(['seriesName']);
    expect(r.normalized).toEqual({ seriesName: null, publisher: 'Tor' });
    expect(r.blanked).toEqual(['seriesName']);
  });
});
