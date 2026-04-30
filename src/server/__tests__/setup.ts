import { vi } from 'vitest';
import type * as DnsPromises from 'node:dns/promises';

/**
 * Global DNS mock for all server-side tests.
 *
 * #769 hardened the outbound-fetch wrappers with an SSRF preflight that calls
 * `dns.lookup()` before every request. Test fixtures use fake hostnames
 * (indexer.test, webhook.test, abs.local, etc.) that don't resolve via real
 * DNS — without this mock those tests would block waiting for DNS or fail
 * with ENOTFOUND.
 *
 * Tests can override the mock per-test:
 *   import { lookup as dnsLookup } from 'node:dns/promises';
 *   vi.mocked(dnsLookup as any).mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
 */
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof DnsPromises>();
  return {
    ...actual,
    lookup: vi.fn().mockImplementation(async (..._args: unknown[]) => {
      // Default to a public IP — tests that need to assert on private IPs
      // override per-test via mockResolvedValueOnce.
      return [{ address: '93.184.216.34', family: 4 }];
    }),
  };
});
