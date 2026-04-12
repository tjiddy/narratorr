import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message.js';

describe('getErrorMessage (client re-export)', () => {
  it('re-exports getErrorMessage from shared module', () => {
    expect(getErrorMessage(new Error('test'))).toBe('test');
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage('oops', 'Custom fallback')).toBe('Custom fallback');
  });
});
