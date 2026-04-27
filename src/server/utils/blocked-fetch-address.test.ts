import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  isBlockedFetchAddress,
  isBlockedHostname,
  isIpLiteral,
  resolveAndValidate,
  BlockedFetchAddressError,
} from './blocked-fetch-address.js';

// dns.lookup is overloaded; the all:true variant returns an array. Cast to a
// permissive Mock so resolved-value typing accepts arrays.
const mockedLookup = vi.mocked(dnsLookup) as unknown as Mock;

describe('isBlockedFetchAddress', () => {
  describe('IPv4 ranges', () => {
    it('blocks 0.0.0.0 (unspecified)', () => {
      expect(isBlockedFetchAddress('0.0.0.0')).toBe(true);
    });

    it.each([
      '10.0.0.0',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.0.1',
      '169.254.169.254',
      '172.16.0.0',
      '172.20.5.5',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
    ])('blocks private/loopback/link-local %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255',
      '172.32.0.0',
      '169.253.255.255',
      '169.255.0.0',
      '93.184.216.34',
    ])('does not block public IPv4 %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
    });
  });

  describe('IPv6 ranges', () => {
    it('blocks :: (unspecified)', () => {
      expect(isBlockedFetchAddress('::')).toBe(true);
    });

    it('blocks ::1 (loopback)', () => {
      expect(isBlockedFetchAddress('::1')).toBe(true);
    });

    it.each(['fe80::1', 'fe80::abcd', 'feaf::1', 'febf::1'])('blocks link-local %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each(['fc00::1', 'fd00::1', 'fdab:cdef::1', 'fcab::1'])('blocks ULA %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each(['2001:db8::1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('does not block public IPv6 %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('blocks ::ffff:127.0.0.1', () => {
      expect(isBlockedFetchAddress('::ffff:127.0.0.1')).toBe(true);
    });

    it('blocks ::ffff:192.168.1.1', () => {
      expect(isBlockedFetchAddress('::ffff:192.168.1.1')).toBe(true);
    });

    it('blocks ::ffff:169.254.169.254', () => {
      expect(isBlockedFetchAddress('::ffff:169.254.169.254')).toBe(true);
    });

    it('blocks ::ffff:0.0.0.0', () => {
      expect(isBlockedFetchAddress('::ffff:0.0.0.0')).toBe(true);
    });

    it('does not block ::ffff:8.8.8.8', () => {
      expect(isBlockedFetchAddress('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('case insensitivity / zone IDs', () => {
    it('matches FE80::1 case-insensitively', () => {
      expect(isBlockedFetchAddress('FE80::1')).toBe(true);
    });

    it('strips IPv6 zone IDs before matching', () => {
      expect(isBlockedFetchAddress('fe80::1%eth0')).toBe(true);
    });
  });
});

describe('isBlockedHostname', () => {
  it('blocks metadata.google.internal', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  it('blocks case-insensitively', () => {
    expect(isBlockedHostname('Metadata.Google.Internal')).toBe(true);
  });

  it('does not block other hostnames', () => {
    expect(isBlockedHostname('cdn.example.com')).toBe(false);
  });
});

describe('isIpLiteral', () => {
  it('detects IPv4 literals', () => {
    expect(isIpLiteral('192.168.1.1')).toBe(true);
  });

  it('detects IPv6 literals', () => {
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('fe80::1')).toBe(true);
  });

  it('returns false for hostnames', () => {
    expect(isIpLiteral('cdn.example.com')).toBe(false);
  });
});

describe('resolveAndValidate', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('returns the IP literal directly when it is public', async () => {
    const result = await resolveAndValidate('8.8.8.8');
    expect(result).toEqual(['8.8.8.8']);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('throws on blocked IP literal without doing lookup', async () => {
    await expect(resolveAndValidate('192.168.1.1')).rejects.toBeInstanceOf(BlockedFetchAddressError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('throws on blocked hostname without doing lookup', async () => {
    await expect(resolveAndValidate('metadata.google.internal')).rejects.toBeInstanceOf(BlockedFetchAddressError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('resolves and returns addresses when all are public', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    const result = await resolveAndValidate('cdn.example.com');
    expect(result).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
  });

  it('throws when any answer is blocked (single private answer)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    await expect(resolveAndValidate('rebind.example.com')).rejects.toBeInstanceOf(BlockedFetchAddressError);
  });

  it('throws on mixed answers where any is blocked (multi-answer DNS)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.2.3.4', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expect(resolveAndValidate('mixed.example.com')).rejects.toBeInstanceOf(BlockedFetchAddressError);
  });

  it('throws when DNS returns zero answers', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    await expect(resolveAndValidate('empty.example.com')).rejects.toBeInstanceOf(BlockedFetchAddressError);
  });
});
