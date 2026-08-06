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

  it('AC3: keeps seriesPosition — no longer an unknown name to drop', () => {
    const log = createMockLogger();
    expect(parseClearedFields('["seriesPosition"]', log, 1)).toEqual(['seriesPosition']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('AC3: keeps a redundant both-entry set without warning', () => {
    const log = createMockLogger();
    expect(parseClearedFields('["seriesName","seriesPosition"]', log, 1)).toEqual(['seriesName', 'seriesPosition']);
    expect(log.warn).not.toHaveBeenCalled();
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

  it('AC3: the canonical sort places seriesPosition directly after seriesName', () => {
    expect(serializeClearedFields([...CLEARABLE_BOOK_FIELDS])).toContain('"seriesName","seriesPosition","subtitle"');
    expect(serializeClearedFields(['seriesPosition', 'seriesName'])).toBe('["seriesName","seriesPosition"]');
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

/**
 * #2152 AC4 — the complete `userAsserted` series matrix, the SOLE statement of
 * what a given (prior set × body) produces. Every row asserts all three outputs;
 * every row is run from the empty prior set AND from the redundant
 * `['seriesName','seriesPosition']` set, since a both-entry set is legal and no
 * row may special-case it.
 */
describe('recomputeClearedFields — AC4 series matrix', () => {
  const BOTH = ['seriesName', 'seriesPosition'] as const;

  describe('row 1 — neither key', () => {
    it('leaves the set, the columns and blanked untouched', () => {
      const r = recomputeClearedFields([], { subtitle: 'x' });
      expect(r.cleared).toEqual([]);
      expect(r.normalized).toEqual({ subtitle: 'x' });
      expect(r.blanked).toEqual([]);
    });

    it('does not repair or rewrite a redundant both-entry prior set (no rule keys on absence)', () => {
      const r = recomputeClearedFields([...BOTH], { subtitle: 'x' });
      expect(r.cleared).toEqual(['seriesName', 'seriesPosition']);
      expect(r.normalized).toEqual({ subtitle: 'x' });
      expect(r.blanked).toEqual([]);
    });
  });

  describe('row 2a — position number, seriesName tombstone NOT live', () => {
    it('removes the position tombstone and stores the number', () => {
      const r = recomputeClearedFields(['seriesPosition'], { seriesPosition: 7 });
      expect(r.cleared).toEqual([]);
      expect(r.normalized).toEqual({ seriesPosition: 7 });
      expect(r.blanked).toEqual([]);
    });

    it('stores 0 as a position, never as a clear (no truthiness coercion)', () => {
      const r = recomputeClearedFields(['seriesPosition'], { seriesPosition: 0 });
      expect(r.cleared).toEqual([]);
      expect(r.normalized.seriesPosition).toBe(0);
      expect(r.blanked).toEqual([]);
    });

    it('stores a fractional position verbatim', () => {
      expect(recomputeClearedFields([], { seriesPosition: 3.5 }).normalized.seriesPosition).toBe(3.5);
    });
  });

  describe('row 2b — position number, seriesName tombstone IS live', () => {
    it('discards the number and nulls the column (rule b), keeping the name tombstone', () => {
      const r = recomputeClearedFields(['seriesName'], { seriesPosition: 7 });
      expect(r.cleared).toEqual(['seriesName']);
      expect(r.normalized.seriesPosition).toBeNull();
      expect(r.blanked).toEqual([]);
    });

    it('behaves the same from the redundant both-entry set (the position tombstone still lifts)', () => {
      const r = recomputeClearedFields([...BOTH], { seriesPosition: 7 });
      expect(r.cleared).toEqual(['seriesName']);
      expect(r.normalized.seriesPosition).toBeNull();
      expect(r.blanked).toEqual([]);
    });

    it('counterfactual: the identical body without a live name tombstone stores 7', () => {
      expect(recomputeClearedFields([], { seriesPosition: 7 }).normalized.seriesPosition).toBe(7);
    });
  });

  describe('row 3 — position null', () => {
    it('adds the position tombstone, nulls the column and lists it in blanked', () => {
      const r = recomputeClearedFields([], { seriesPosition: null });
      expect(r.cleared).toEqual(['seriesPosition']);
      expect(r.normalized).toEqual({ seriesPosition: null });
      expect(r.blanked).toEqual(['seriesPosition']);
    });

    it('from the redundant both-entry set still yields both entries', () => {
      const r = recomputeClearedFields([...BOTH], { seriesPosition: null });
      expect(r.cleared).toEqual(['seriesName', 'seriesPosition']);
      expect(r.normalized).toEqual({ seriesPosition: null });
      expect(r.blanked).toEqual(['seriesPosition']);
    });
  });

  describe('row 4 — non-blank name, position absent', () => {
    it('removes both tombstones (rule a) and leaves the stored position untouched', () => {
      const r = recomputeClearedFields([...BOTH], { seriesName: 'Dune' });
      expect(r.cleared).toEqual([]);
      expect(r.normalized).toEqual({ seriesName: 'Dune' });
      expect(r.blanked).toEqual([]);
    });
  });

  describe('row 5 — non-blank name + position number', () => {
    it('removes both tombstones and stores both values', () => {
      const r = recomputeClearedFields([...BOTH], { seriesName: 'Dune', seriesPosition: 7 });
      expect(r.cleared).toEqual([]);
      expect(r.normalized).toEqual({ seriesName: 'Dune', seriesPosition: 7 });
      expect(r.blanked).toEqual([]);
    });
  });

  describe("row 6 — non-blank name + position null (the body's own key beats rule a)", () => {
    it('removes the name tombstone and ADDS the position tombstone', () => {
      const r = recomputeClearedFields([], { seriesName: 'Dune', seriesPosition: null });
      expect(r.cleared).toEqual(['seriesPosition']);
      expect(r.normalized).toEqual({ seriesName: 'Dune', seriesPosition: null });
      expect(r.blanked).toEqual(['seriesPosition']);
    });

    it('same outcome from the redundant both-entry set', () => {
      const r = recomputeClearedFields([...BOTH], { seriesName: 'Dune', seriesPosition: null });
      expect(r.cleared).toEqual(['seriesPosition']);
      expect(r.blanked).toEqual(['seriesPosition']);
    });
  });

  describe('row 7 — blank name, position absent', () => {
    it('adds the name tombstone, nulls BOTH columns and lists only seriesName in blanked', () => {
      const r = recomputeClearedFields([], { seriesName: null });
      expect(r.cleared).toEqual(['seriesName']);
      expect(r.normalized).toEqual({ seriesName: null, seriesPosition: null });
      expect(r.blanked).toEqual(['seriesName']);
    });

    it('leaves an existing position tombstone alone while rule b nulls the column', () => {
      const r = recomputeClearedFields(['seriesPosition'], { seriesName: '   ' });
      expect(r.cleared).toEqual(['seriesName', 'seriesPosition']);
      expect(r.normalized.seriesName).toBeNull();
      expect(r.normalized.seriesPosition).toBeNull();
      expect(r.blanked).toEqual(['seriesName']);
    });
  });

  describe('row 8 — blank name + position number', () => {
    it('discards the number (rule b) and lists only seriesName in blanked', () => {
      const r = recomputeClearedFields([], { seriesName: null, seriesPosition: 5 });
      expect(r.cleared).toEqual(['seriesName']);
      expect(r.normalized).toEqual({ seriesName: null, seriesPosition: null });
      expect(r.blanked).toEqual(['seriesName']);
    });

    it('removes a pre-existing position tombstone even though the number is discarded', () => {
      const r = recomputeClearedFields([...BOTH], { seriesName: '', seriesPosition: 5 });
      expect(r.cleared).toEqual(['seriesName']);
      expect(r.normalized.seriesPosition).toBeNull();
      expect(r.blanked).toEqual(['seriesName']);
    });
  });

  describe('row 9 — blank name + position null', () => {
    it('adds both tombstones, nulls both columns and lists both in blanked', () => {
      const r = recomputeClearedFields([], { seriesName: null, seriesPosition: null });
      expect(r.cleared).toEqual(['seriesName', 'seriesPosition']);
      expect(r.normalized).toEqual({ seriesName: null, seriesPosition: null });
      expect(r.blanked).toEqual(['seriesName', 'seriesPosition']);
    });

    it('is idempotent from the redundant both-entry set', () => {
      const r = recomputeClearedFields([...BOTH], { seriesName: null, seriesPosition: null });
      expect(r.cleared).toEqual(['seriesName', 'seriesPosition']);
      expect(r.blanked).toEqual(['seriesName', 'seriesPosition']);
    });
  });

  it('AC6: a position-only update never touches the seriesName tombstone or column', () => {
    for (const body of [{ seriesPosition: null }, { seriesPosition: 7 }, { seriesPosition: 0 }]) {
      const fresh = recomputeClearedFields([], body);
      expect(fresh.cleared).not.toContain('seriesName');
      expect(fresh.normalized).not.toHaveProperty('seriesName');

      const tombstoned = recomputeClearedFields(['seriesName'], body);
      expect(tombstoned.cleared).toContain('seriesName');
      expect(tombstoned.normalized).not.toHaveProperty('seriesName');
    }
  });
});

describe('recomputeClearedFields — non-clearable keys', () => {
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
    // `seriesPosition: null` rides along from AC4's rule **b** — the column
    // follows the name tombstone even though the body never named the key.
    expect(r.normalized).toEqual({ seriesName: null, seriesPosition: null, publisher: 'Tor' });
    expect(r.blanked).toEqual(['seriesName']);
  });
});
