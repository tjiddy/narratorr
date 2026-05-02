import { describe, it, expect } from 'vitest';
import { mapNetworkError } from './map-network-error.js';

describe('mapNetworkError', () => {
  describe('error code mapping', () => {
    it('ECONNREFUSED → message includes "Connection refused" and port', () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/connection refused/i);
      expect(result.message).toMatch(/9999/);
    });

    it('ENOTFOUND → message includes "DNS resolution failed" and hostname', () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.example'), { code: 'ENOTFOUND' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/dns/i);
      expect(result.message).toMatch(/badhost\.example/);
    });

    it('UND_ERR_CONNECT_TIMEOUT → message includes "timed out"', () => {
      const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/timed out/i);
    });

    it('ETIMEDOUT → message includes "timed out"', () => {
      const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/timed out/i);
    });

    it('AbortError (manual abort) → message includes "timed out"', () => {
      const original = new DOMException('The operation was aborted', 'AbortError');
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/timed out/i);
    });

    it('TimeoutError (AbortSignal.timeout) → message includes "timed out"', () => {
      const original = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/timed out/i);
    });

    it('ECONNRESET → message includes "Connection reset"', () => {
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/connection reset/i);
    });

    it('UND_ERR_HEADERS_TIMEOUT → message indicates server stopped responding before headers', () => {
      const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toBe('Server stopped responding before sending headers');
    });

    it('UND_ERR_BODY_TIMEOUT → message indicates server stopped mid-response', () => {
      const cause = Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toBe('Server stopped responding mid-response');
    });

    it('UND_ERR_RESPONSE_EXCEEDED_SIZE → message indicates size limit', () => {
      const cause = Object.assign(new Error('Response size exceeded'), { code: 'UND_ERR_RESPONSE_EXCEEDED_SIZE' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toBe('Response exceeded size limit');
    });
  });

  describe('direct Error.code (no TypeError wrapping)', () => {
    // SSRF DNS preflight (resolveAndValidate) throws raw Errno-style errors before fetch wraps them
    it('direct ENOTFOUND → message includes "DNS resolution failed" and hostname', () => {
      const original = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.example'), { code: 'ENOTFOUND' });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/dns/i);
      expect(result.message).toMatch(/badhost\.example/);
    });

    it('direct ECONNREFUSED → message includes "Connection refused" and port', () => {
      const original = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
      const result = mapNetworkError(original);
      expect(result.message).toMatch(/connection refused/i);
      expect(result.message).toMatch(/9999/);
    });
  });

  describe('passthrough', () => {
    it('non-network TypeError is returned as-is', () => {
      const original = new TypeError('Cannot read properties of undefined');
      const result = mapNetworkError(original);
      expect(result).toBe(original);
    });

    it('non-TypeError errors are returned as-is', () => {
      const original = new Error('HTTP 401: Unauthorized');
      const result = mapNetworkError(original);
      expect(result).toBe(original);
    });

    it('TypeError with unknown cause code is returned with cause message', () => {
      const cause = Object.assign(new Error('unknown network issue'), { code: 'UNKNOWN_CODE' });
      const original = Object.assign(new TypeError('fetch failed'), { cause });
      const result = mapNetworkError(original);
      expect(result.message).toContain('unknown network issue');
    });
  });
});
