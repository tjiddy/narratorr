import { describe, expect, it } from 'vitest';
import { serializeError } from './serialize-error.js';

describe('serializeError', () => {
  describe('Error instances', () => {
    it('serializes Error with message and stack', () => {
      const err = new Error('something broke');
      const result = serializeError(err);

      expect(result.message).toBe('something broke');
      expect(result.type).toBe('Error');
      expect(result.stack).toBeDefined();
      expect(result.stack).toContain('something broke');
    });

    it('captures constructor name as type for Error subclasses', () => {
      const typeErr = serializeError(new TypeError('bad type'));
      expect(typeErr.type).toBe('TypeError');
      expect(typeErr.message).toBe('bad type');

      const rangeErr = serializeError(new RangeError('out of range'));
      expect(rangeErr.type).toBe('RangeError');
      expect(rangeErr.message).toBe('out of range');
    });

    it('returns empty string message for Error with no message', () => {
      const result = serializeError(new Error());
      expect(result.message).toBe('');
      expect(result.type).toBe('Error');
      expect(result.stack).toBeDefined();
    });
  });

  describe('Error.cause chain', () => {
    it('serializes single .cause recursively', () => {
      const inner = new Error('root cause');
      const outer = new Error('wrapper', { cause: inner });
      const result = serializeError(outer);

      expect(result.message).toBe('wrapper');
      expect(result.cause).toBeDefined();
      expect(result.cause!.message).toBe('root cause');
      expect(result.cause!.type).toBe('Error');
      expect(result.cause!.stack).toBeDefined();
    });

    it('serializes 2-level cause chain', () => {
      const root = new Error('level 0');
      const mid = new Error('level 1', { cause: root });
      const top = new Error('level 2', { cause: mid });
      const result = serializeError(top);

      expect(result.message).toBe('level 2');
      expect(result.cause!.message).toBe('level 1');
      expect(result.cause!.cause!.message).toBe('level 0');
      expect(result.cause!.cause!.cause).toBeUndefined();
    });

    it('serializes cause chain at exactly the depth cap', () => {
      // Build a chain of exactly 5 levels (depth cap)
      let err: Error = new Error('level 0');
      for (let i = 1; i < 5; i++) {
        err = new Error(`level ${i}`, { cause: err });
      }
      const result = serializeError(err);

      // Walk the chain — should have all 5 levels
      let current = result;
      for (let i = 4; i >= 1; i--) {
        expect(current.message).toBe(`level ${i}`);
        current = current.cause!;
      }
      expect(current.message).toBe('level 0');
      expect(current.cause).toBeUndefined();
    });

    it('truncates cause chain exceeding depth cap without crash', () => {
      // Build a chain of 10 levels — should be truncated at 5
      let err: Error = new Error('level 0');
      for (let i = 1; i < 10; i++) {
        err = new Error(`level ${i}`, { cause: err });
      }
      const result = serializeError(err);

      // Count depth
      let depth = 0;
      let current: typeof result | undefined = result;
      while (current) {
        depth++;
        current = current.cause;
      }
      expect(depth).toBeLessThanOrEqual(6); // top + 5 cause levels max
    });
  });

  describe('circular references', () => {
    it('handles self-referential cause without throwing or looping', () => {
      const err = new Error('circular');
      (err as Error & { cause: Error }).cause = err;
      const result = serializeError(err);

      expect(result.message).toBe('circular');
      expect(result.type).toBe('Error');
      // Should not have infinite cause chain
      expect(result.cause).toBeUndefined();
    });

    it('handles indirect cycle (A → B → A) via Set tracker', () => {
      const a = new Error('A');
      const b = new Error('B', { cause: a });
      (a as Error & { cause: Error }).cause = b;

      const result = serializeError(a);
      expect(result.message).toBe('A');
      expect(result.cause!.message).toBe('B');
      // The cycle should be broken
      expect(result.cause!.cause).toBeUndefined();
    });
  });

  describe('non-Error primitives', () => {
    it('serializes string value', () => {
      const result = serializeError('connection refused');
      expect(result.message).toBe('connection refused');
      expect(result.type).toBe('string');
      expect(result.stack).toBeUndefined();
    });

    it('serializes number value including zero', () => {
      const result = serializeError(0);
      expect(result.message).toBe('0');
      expect(result.type).toBe('number');
      expect(result.stack).toBeUndefined();

      const result42 = serializeError(42);
      expect(result42.message).toBe('42');
    });

    it('serializes null', () => {
      const result = serializeError(null);
      expect(result.message).toBe('null');
      expect(result.type).toBe('object');
      expect(result.stack).toBeUndefined();
    });

    it('serializes undefined', () => {
      const result = serializeError(undefined);
      expect(result.message).toBe('undefined');
      expect(result.type).toBe('undefined');
      expect(result.stack).toBeUndefined();
    });

    it('serializes boolean false', () => {
      const result = serializeError(false);
      expect(result.message).toBe('false');
      expect(result.type).toBe('boolean');
      expect(result.stack).toBeUndefined();
    });
  });

  describe('plain objects (no duck-typing)', () => {
    it('serializes plain object as String(value) without duck-typing', () => {
      const result = serializeError({ foo: 'bar' });
      expect(result.message).toBe('[object Object]');
      expect(result.type).toBe('object');
      expect(result.stack).toBeUndefined();
    });

    it('does not duck-type object with .message property', () => {
      const result = serializeError({ message: 'I look like an error' });
      expect(result.message).toBe('[object Object]');
      expect(result.type).toBe('object');
    });

    it('does not duck-type object with .stack property', () => {
      const result = serializeError({ stack: 'fake stack trace' });
      expect(result.message).toBe('[object Object]');
      expect(result.type).toBe('object');
      expect(result.stack).toBeUndefined();
    });
  });

  describe('never-throw guarantee', () => {
    it('returns a result for any input — never throws', () => {
      const inputs: unknown[] = [
        new Error('normal'),
        'string',
        42,
        null,
        undefined,
        false,
        { weird: 'object' },
        Symbol('sym'),
        () => 'function',
        BigInt(99),
        [],
        new Map(),
        new Set(),
      ];

      for (const input of inputs) {
        expect(() => serializeError(input)).not.toThrow();
        const result = serializeError(input);
        expect(result).toHaveProperty('message');
        expect(result).toHaveProperty('type');
      }
    });
  });
});
