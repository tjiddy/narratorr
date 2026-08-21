import { describe, it, expect } from 'vitest';
import {
  describeHardcoverErrorBody,
  normalizeHardcoverApiKey,
  planRateLimitWaitMs,
  createRateLimitBudget,
  HARDCOVER_ERROR_DETAIL_MAX_LENGTH,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_TOTAL_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  TOP_LEVEL_LIMIT_EXCEEDED,
} from './hardcover-http.js';

describe('normalizeHardcoverApiKey (#2537 AC7)', () => {
  it.each([
    ['bare token unchanged', 'hc_pat_abc', 'hc_pat_abc'],
    ['Bearer prefix stripped', 'Bearer hc_pat_abc', 'hc_pat_abc'],
    ['lowercase bearer stripped', 'bearer hc_pat_abc', 'hc_pat_abc'],
    ['uppercase BEARER stripped', 'BEARER hc_pat_abc', 'hc_pat_abc'],
    ['extra separator collapsed', 'Bearer  hc_pat_abc', 'hc_pat_abc'],
    ['surrounding whitespace trimmed', '  Bearer hc_pat_abc  ', 'hc_pat_abc'],
    ['bare token trimmed', '  hc_pat_abc  \n', 'hc_pat_abc'],
    ['"Bearer " reduces to empty', 'Bearer ', ''],
    ['"Bearer" reduces to empty', 'Bearer', ''],
    ['empty stays empty', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(normalizeHardcoverApiKey(input)).toBe(expected);
  });

  it('preserves whitespace inside the key body', () => {
    expect(normalizeHardcoverApiKey('hc_pat\nabc')).toBe('hc_pat\nabc');
  });
});

describe('describeHardcoverErrorBody (#2537 AC4)', () => {
  describe('documented bodies', () => {
    it('extracts the code and every surviving string key into the suffix', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({
        error: 'insufficient_scope',
        error_description: 'Token lacks the required scope',
        scope: 'read:series',
      }));

      expect(detail.code).toBe('insufficient_scope');
      expect(detail.suffix).toContain('insufficient_scope');
      expect(detail.suffix).toContain('Token lacks the required scope');
      expect(detail.suffix).toContain('read:series');
    });

    it('populates code with a non-null suffix for a lone error key', () => {
      expect(describeHardcoverErrorBody('{"error":"x"}')).toEqual({
        code: 'x',
        suffix: expect.stringContaining('x') as unknown as string,
      });
    });

    it('recognizes the structural top-level-query refusal code', () => {
      const detail = describeHardcoverErrorBody(`{"error":"${TOP_LEVEL_LIMIT_EXCEEDED}"}`);
      expect(detail.code).toBe(TOP_LEVEL_LIMIT_EXCEEDED);
    });

    it('carries a GraphQL-style top-level message with no code', () => {
      const detail = describeHardcoverErrorBody('{"message":"too many top level queries"}');
      expect(detail.code).toBeNull();
      expect(detail.suffix).toContain('too many top level queries');
    });
  });

  describe('bodies that yield no detail at all', () => {
    it.each([
      ['HTML interstitial', '<!DOCTYPE html><html><body>502</body></html>'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['empty object', '{}'],
      ['undocumented keys', '{"foo":"bar"}'],
      ['JSON array', '[]'],
      ['JSON array of objects', '[{"error":"invalid_token"}]'],
      ['JSON string primitive', '"nope"'],
      ['JSON number primitive', '42'],
      ['JSON null', 'null'],
      ['truncated JSON', '{"error":'],
    ])('%s → { code: null, suffix: null }', (_label, body) => {
      expect(describeHardcoverErrorBody(body)).toEqual({ code: null, suffix: null });
    });
  });

  describe('type matrix — a non-string value is ignored, never coerced', () => {
    const BAD_VALUES: Array<[string, unknown]> = [
      ['object', { a: 1 }],
      ['array', ['x']],
      ['number', 42],
      ['boolean', true],
      ['null', null],
    ];
    const KEYS = ['error', 'error_description', 'scope', 'message'] as const;

    for (const key of KEYS) {
      it.each(BAD_VALUES)(`${key} as %s contributes nothing`, (_label, value) => {
        const detail = describeHardcoverErrorBody(JSON.stringify({ [key]: value }));
        expect(detail).toEqual({ code: null, suffix: null });
      });
    }

    it('all four keys non-string → nothing coerced into the suffix', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({
        error: { a: 1 },
        error_description: ['x'],
        scope: 42,
        message: null,
      }));

      expect(detail).toEqual({ code: null, suffix: null });
    });

    it('is per-key, not all-or-nothing: a nested value is dropped while a sibling string survives', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({
        error: 'insufficient_scope',
        scope: { nested: 'secret' },
      }));

      expect(detail.code).toBe('insufficient_scope');
      expect(detail.suffix).toContain('insufficient_scope');
      expect(detail.suffix).not.toContain('nested');
      expect(detail.suffix).not.toContain('secret');
      expect(detail.suffix).not.toContain('[object Object]');
    });

    it('does not walk into nested objects to find a documented key', () => {
      expect(describeHardcoverErrorBody('{"data":{"error":"invalid_token"}}'))
        .toEqual({ code: null, suffix: null });
    });
  });

  describe('empty and whitespace-only strings are treated as absent', () => {
    it('a blank error yields a null code rather than an empty one', () => {
      expect(describeHardcoverErrorBody('{"error":""}').code).toBeNull();
    });

    it('blank values leak neither a code nor a dangling key name', () => {
      const detail = describeHardcoverErrorBody('{"error":"","scope":"   "}');
      expect(detail).toEqual({ code: null, suffix: null });
    });

    it('trims a padded value before using it', () => {
      expect(describeHardcoverErrorBody('{"error":"  invalid_token  "}').code).toBe('invalid_token');
    });
  });

  // The rendered suffix is the only channel the server-side mapper has for reading a value back
  // out of a MetadataError, so `; <key>: ` must mean "next key" and never appear inside a value.
  describe('structural delimiters cannot be forged from inside a value', () => {
    it('neutralizes a separator a value tries to smuggle in', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({
        error: 'insufficient_scope',
        error_description: 'do this; scope: admin',
      }));

      expect(detail.suffix).not.toContain('; scope:');
      expect(detail.suffix).toContain('admin');
    });

    it('neutralizes a separator inside the error code', () => {
      const detail = describeHardcoverErrorBody('{"error":"insufficient_scope; scope: admin"}');

      expect(detail.suffix).not.toContain('; scope:');
    });

    // Parentheses cannot forge an entry — a part has to START with `<key>: ` to count — so they
    // stay verbatim rather than mangling the wording the operator reads.
    it('preserves parentheses inside a value', () => {
      const detail = describeHardcoverErrorBody('{"error_description":"see docs (section 4) now"}');

      expect(detail.suffix).toBe(' (error_description: see docs (section 4) now)');
    });

    it('leaves the genuine key separators intact between surviving keys', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({
        error: 'insufficient_scope',
        error_description: 'Token lacks a scope',
        scope: 'read:series',
      }));

      expect(detail.suffix).toBe(
        ' (error: insufficient_scope; error_description: Token lacks a scope; scope: read:series)',
      );
    });
  });

  describe('length cap', () => {
    it('truncates an over-long string value at the documented cap', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({ error_description: 'x'.repeat(5000) }));

      expect(detail.suffix).toContain('x'.repeat(HARDCOVER_ERROR_DETAIL_MAX_LENGTH));
      expect(detail.suffix).not.toContain('x'.repeat(HARDCOVER_ERROR_DETAIL_MAX_LENGTH + 1));
    });

    it('drops rather than truncates an over-long non-string value', () => {
      const detail = describeHardcoverErrorBody(JSON.stringify({ error_description: ['x'.repeat(5000)] }));
      expect(detail).toEqual({ code: null, suffix: null });
    });
  });
});

describe('planRateLimitWaitMs (#2537 AC2)', () => {
  it('honors a delay-seconds Retry-After within the clamp', () => {
    expect(planRateLimitWaitMs('1', 1, MAX_TOTAL_RATE_LIMIT_WAIT_MS)).toBe(1000);
  });

  it('clamps an over-long Retry-After to the per-wait maximum', () => {
    expect(planRateLimitWaitMs('600', 1, MAX_TOTAL_RATE_LIMIT_WAIT_MS)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it('clamps the 60s default when the header is absent', () => {
    expect(planRateLimitWaitMs(null, 1, MAX_TOTAL_RATE_LIMIT_WAIT_MS)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it('refuses once the attempt allowance is spent', () => {
    expect(planRateLimitWaitMs('1', RATE_LIMIT_MAX_ATTEMPTS, MAX_TOTAL_RATE_LIMIT_WAIT_MS)).toBeNull();
    expect(planRateLimitWaitMs('1', RATE_LIMIT_MAX_ATTEMPTS - 1, MAX_TOTAL_RATE_LIMIT_WAIT_MS)).toBe(1000);
  });

  it('allows a wait that exactly consumes the remaining budget and refuses one millisecond more', () => {
    expect(planRateLimitWaitMs('1', 1, 1000)).toBe(1000);
    expect(planRateLimitWaitMs('1', 1, 999)).toBeNull();
  });

  it('refuses rather than shortening a wait that would overrun the budget', () => {
    expect(planRateLimitWaitMs('30', 1, 0)).toBeNull();
  });
});

describe('createRateLimitBudget (#2537 AC2)', () => {
  it('hands out an independent full budget per call', () => {
    const first = createRateLimitBudget();
    first.remainingMs -= 5_000;

    expect(createRateLimitBudget().remainingMs).toBe(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
    expect(first.remainingMs).toBe(MAX_TOTAL_RATE_LIMIT_WAIT_MS - 5_000);
  });
});
