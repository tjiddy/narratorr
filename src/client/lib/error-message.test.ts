import { describe, expect, it } from 'vitest';

describe('getErrorMessage', () => {
  it.todo('returns .message from Error instances');
  it.todo('returns .message from Error subclasses (TypeError, RangeError)');
  it.todo('returns fallback for non-Error primitives (string, number, boolean)');
  it.todo('returns fallback for null');
  it.todo('returns fallback for undefined');
  it.todo('returns fallback for plain object');
  it.todo('returns .message from custom Error subclass');
  it.todo('returns empty string when Error has empty .message');
  it.todo('uses provided custom fallback string for non-Error values');
  it.todo('uses Unknown error as default when no fallback provided');
});
