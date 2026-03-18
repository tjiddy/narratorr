import { describe, it, expect } from 'vitest';
import { RateLimitError, TransientError } from './errors.js';

describe('RateLimitError', () => {
  it('constructs with correct properties', () => {
    const error = new RateLimitError(30000, 'Hardcover');

    expect(error.retryAfterMs).toBe(30000);
    expect(error.provider).toBe('Hardcover');
    expect(error.name).toBe('RateLimitError');
    expect(error.message).toBe('Hardcover rate limit exceeded, retry after 30s');
  });

  it('rounds up seconds in message', () => {
    const error = new RateLimitError(1500, 'Google Books');

    expect(error.message).toBe('Google Books rate limit exceeded, retry after 2s');
  });

  it('is instanceof Error', () => {
    const error = new RateLimitError(60000, 'Hardcover');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RateLimitError);
  });
});

describe('TransientError', () => {
  it('constructs with correct name property', () => {
    const error = new TransientError('Audible', 'Connection timed out');

    expect(error.name).toBe('TransientError');
    expect(error.provider).toBe('Audible');
  });

  it('includes provider name and failure context in message', () => {
    const error = new TransientError('Audnexus', 'HTTP 503 Service Unavailable');

    expect(error.message).toBe('Audnexus transient failure: HTTP 503 Service Unavailable');
  });

  it('is instanceof Error', () => {
    const error = new TransientError('Audible', 'timeout');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TransientError);
  });
});
