import { describe, expect, it } from 'vitest';
import {
  DownloadClientAuthError,
  DownloadClientError,
  DownloadClientTimeoutError,
  isTimeoutError,
} from './errors.js';

describe('DownloadClientError', () => {
  it('is base class with clientName field and extends Error', () => {
    const error = new DownloadClientError('qBittorrent', 'something broke');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error.clientName).toBe('qBittorrent');
    expect(error.message).toBe('something broke');
  });

  it('sets name property to class name for serialization', () => {
    const error = new DownloadClientError('qBittorrent', 'test');
    expect(error.name).toBe('DownloadClientError');
  });

  it('uses default message when none provided', () => {
    const error = new DownloadClientError('Deluge');
    expect(error.message).toBe('Download client error: Deluge');
  });
});

describe('DownloadClientAuthError', () => {
  it('has clientName field and extends DownloadClientError', () => {
    const error = new DownloadClientAuthError('Transmission', 'bad credentials');
    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error).toBeInstanceOf(DownloadClientAuthError);
    expect(error.clientName).toBe('Transmission');
    expect(error.message).toBe('bad credentials');
  });

  it('instanceof check works for both DownloadClientAuthError and Error', () => {
    const error = new DownloadClientAuthError('qBittorrent');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error).toBeInstanceOf(DownloadClientAuthError);
  });

  it('sets name property to DownloadClientAuthError', () => {
    const error = new DownloadClientAuthError('SABnzbd');
    expect(error.name).toBe('DownloadClientAuthError');
  });

  it('uses default message when none provided', () => {
    const error = new DownloadClientAuthError('NZBGet');
    expect(error.message).toBe('Authentication failed for download client: NZBGet');
  });
});

describe('DownloadClientTimeoutError', () => {
  it('has clientName field and extends DownloadClientError', () => {
    const error = new DownloadClientTimeoutError('qBittorrent', 'Request timed out');
    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error).toBeInstanceOf(DownloadClientTimeoutError);
    expect(error.clientName).toBe('qBittorrent');
    expect(error.message).toBe('Request timed out');
  });

  it('instanceof check works for both DownloadClientTimeoutError and Error', () => {
    const error = new DownloadClientTimeoutError('Deluge');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error).toBeInstanceOf(DownloadClientTimeoutError);
  });

  it('sets name property to DownloadClientTimeoutError', () => {
    const error = new DownloadClientTimeoutError('Transmission');
    expect(error.name).toBe('DownloadClientTimeoutError');
  });

  it('uses default message when none provided', () => {
    const error = new DownloadClientTimeoutError('SABnzbd');
    expect(error.message).toBe('Request timed out for download client: SABnzbd');
  });
});

describe('isTimeoutError', () => {
  it('returns true for "Request timed out" message', () => {
    expect(isTimeoutError(new Error('Request timed out'))).toBe(true);
  });

  it('returns true for "Connection timed out" message', () => {
    expect(isTimeoutError(new Error('Connection timed out'))).toBe(true);
  });

  it('returns false for other error messages', () => {
    expect(isTimeoutError(new Error('Connection refused on port 8080'))).toBe(false);
    expect(isTimeoutError(new Error('DNS resolution failed for example.com'))).toBe(false);
    expect(isTimeoutError(new Error('something else'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTimeoutError('Request timed out')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});
