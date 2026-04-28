import { describe, expect, it } from 'vitest';
import { IndexerAuthError, IndexerError, ProxyError, isProxyRelatedError } from './errors.js';

describe('IndexerAuthError', () => {
  it('has indexerName field and extends Error', () => {
    const error = new IndexerAuthError('MAM', 'bad credentials');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IndexerAuthError);
    expect(error.indexerName).toBe('MAM');
    expect(error.message).toBe('bad credentials');
    expect(error.name).toBe('IndexerAuthError');
  });

  it('uses default message when none provided', () => {
    const error = new IndexerAuthError('Newznab');
    expect(error.message).toBe('Authentication failed for indexer: Newznab');
  });

  it('preserves .cause when constructed with options', () => {
    const cause = new Error('401 Unauthorized');
    const error = new IndexerAuthError('MAM', 'auth failed', { cause });
    expect(error.cause).toBe(cause);
  });

  it('without options has undefined .cause', () => {
    const error = new IndexerAuthError('MAM');
    expect(error.cause).toBeUndefined();
  });
});

describe('IndexerError', () => {
  it('has indexerName field and extends Error', () => {
    const error = new IndexerError('MAM', 'shape mismatch');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IndexerError);
    expect(error.indexerName).toBe('MAM');
    expect(error.message).toBe('shape mismatch');
  });

  it('sets name property to class name', () => {
    const error = new IndexerError('MAM', 'test');
    expect(error.name).toBe('IndexerError');
  });

  it('preserves .cause when constructed with options', () => {
    const cause = new Error('zod validation failed');
    const error = new IndexerError('MAM', 'wrapper message', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('wrapper message');
    expect(error.indexerName).toBe('MAM');
  });

  it('without options has undefined .cause', () => {
    const error = new IndexerError('MAM', 'test');
    expect(error.cause).toBeUndefined();
  });

  it('uses default message when none provided', () => {
    const error = new IndexerError('MAM');
    expect(error.message).toBe('Indexer error: MAM');
  });
});

describe('ProxyError', () => {
  it('extends Error', () => {
    const error = new ProxyError('proxy failure');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProxyError);
    expect(error.message).toBe('proxy failure');
    expect(error.name).toBe('ProxyError');
  });

  it('preserves .cause when constructed with options', () => {
    const cause = new Error('socket hang up');
    const error = new ProxyError('proxy failure', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('isProxyRelatedError', () => {
  it('returns true for ProxyError', () => {
    expect(isProxyRelatedError(new ProxyError('failure'))).toBe(true);
  });

  it('returns true for FlareSolverr-prefixed errors', () => {
    expect(isProxyRelatedError(new Error('FlareSolverr returned 500'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isProxyRelatedError(new Error('other failure'))).toBe(false);
    expect(isProxyRelatedError(null)).toBe(false);
  });
});
