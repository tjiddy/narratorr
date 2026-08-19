import { describe, it, expect } from 'vitest';
import { connectorConnectionError, ConnectorRequestError } from './errors.js';

// #2317 Part B. The helper's only input handling is getErrorMessage, and a raw throw off
// fetchWithTimeout can be any shape — mapNetworkError only normalises its own return value.
// These rows pin that the helper never branches on input shape, at the seam that owns it;
// getErrorMessage's own fallbacks are pinned separately in src/shared/error-message.test.ts.
describe('connectorConnectionError', () => {
  it.each([
    ['an Error', new Error('boom'), 'Connection failed: boom'],
    ['a string throw', 'boom', 'Connection failed: boom'],
    ['undefined', undefined, 'Connection failed: undefined'],
    ['null', null, 'Connection failed: null'],
  ])('formats %s without changing the verdict', (_label, input, expected) => {
    const error = connectorConnectionError(input);

    expect(error).toBeInstanceOf(ConnectorRequestError);
    expect(error.message).toBe(expected);
    expect(error.retryable).toBe(true);
    expect(error.fieldErrors).toEqual({ baseUrl: 'Could not connect to server' });
  });
});
