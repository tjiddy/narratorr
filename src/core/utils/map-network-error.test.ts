import { describe, it } from 'vitest';

describe('mapNetworkError', () => {
  describe('error code mapping', () => {
    it.todo('ECONNREFUSED → message includes "Connection refused" and port');
    it.todo('ENOTFOUND → message includes "DNS resolution failed" and hostname');
    it.todo('UND_ERR_CONNECT_TIMEOUT → message includes "timed out"');
    it.todo('ETIMEDOUT → message includes "timed out"');
    it.todo('AbortError → message includes "timed out"');
  });

  describe('passthrough', () => {
    it.todo('non-network TypeError is returned as-is');
    it.todo('non-TypeError errors are returned as-is');
  });
});
