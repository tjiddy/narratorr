import { describe, it } from 'vitest';

describe('serializeError', () => {
  describe('Error instances', () => {
    it.todo('serializes Error with message and stack');
    it.todo('captures constructor name as type for Error subclasses (TypeError, RangeError)');
    it.todo('returns empty string message for Error with no message');
  });

  describe('Error.cause chain', () => {
    it.todo('serializes single .cause recursively');
    it.todo('serializes 2-level cause chain');
    it.todo('serializes cause chain at exactly the depth cap');
    it.todo('truncates cause chain exceeding depth cap without crash');
  });

  describe('circular references', () => {
    it.todo('handles self-referential cause without throwing or looping');
    it.todo('handles indirect cycle (A → B → A) via Set tracker');
  });

  describe('non-Error primitives', () => {
    it.todo('serializes string value');
    it.todo('serializes number value including zero');
    it.todo('serializes null');
    it.todo('serializes undefined');
    it.todo('serializes boolean false');
  });

  describe('plain objects (no duck-typing)', () => {
    it.todo('serializes plain object as String(value) without duck-typing');
    it.todo('does not duck-type object with .message property');
    it.todo('does not duck-type object with .stack property');
  });

  describe('never-throw guarantee', () => {
    it.todo('returns a result for any input — never throws');
  });
});
