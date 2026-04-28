import { describe, expect, it } from 'vitest';
import { ImportListError } from './errors.js';

describe('ImportListError', () => {
  it('is base class with provider field and extends Error', () => {
    const error = new ImportListError('NYT', 'something broke');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ImportListError);
    expect(error.provider).toBe('NYT');
    expect(error.message).toBe('something broke');
  });

  it('sets name property to class name for serialization', () => {
    const error = new ImportListError('Hardcover', 'test');
    expect(error.name).toBe('ImportListError');
  });

  it('constructed with { cause } preserves .cause through hierarchy', () => {
    const cause = new Error('original failure');
    const error = new ImportListError('Audiobookshelf', 'wrapper message', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('wrapper message');
    expect(error.provider).toBe('Audiobookshelf');
  });

  it('constructed without options has undefined .cause', () => {
    const error = new ImportListError('NYT', 'test');
    expect(error.cause).toBeUndefined();
  });
});
