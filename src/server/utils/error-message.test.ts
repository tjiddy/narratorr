import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message.js';

describe('getErrorMessage (server re-export)', () => {
  it('re-exports getErrorMessage from shared module', () => {
    expect(getErrorMessage(new Error('test'))).toBe('test');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage('oops')).toBe('oops');
  });
});
