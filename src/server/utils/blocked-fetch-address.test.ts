import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  isBlockedFetchAddress,
  isBlockedHostname,
  isIpLiteral,
  normalizeHostname,
  resolveAndValidate,
  validatingLookup,
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
      '100.64.0.0',
      '100.64.0.1',
      '100.100.50.50',
      '100.127.255.255',
    ])('blocks CGNAT %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each([
      '100.63.255.255',
      '100.128.0.0',
    ])('does not block CGNAT-adjacent %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
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

    it.each(['ff00::', 'ff02::1', 'ff05::101', 'ff0e::1', 'FF02::1'])('blocks multicast %s', (ip) => {
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

    it('blocks ::ffff:100.64.0.1 (CGNAT)', () => {
      expect(isBlockedFetchAddress('::ffff:100.64.0.1')).toBe(true);
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

describe('normalizeHostname', () => {
  it('strips surrounding brackets from IPv6 literal hostnames', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('[fd00::1]')).toBe('fd00::1');
    expect(normalizeHostname('[fe80::1]')).toBe('fe80::1');
  });

  it('returns hostnames without brackets unchanged', () => {
    expect(normalizeHostname('cdn.example.com')).toBe('cdn.example.com');
    expect(normalizeHostname('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeHostname('::1')).toBe('::1');
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
    await expect(resolveAndValidate('192.168.1.1')).rejects.toThrow(/Refused/);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('throws on blocked hostname without doing lookup', async () => {
    await expect(resolveAndValidate('metadata.google.internal')).rejects.toThrow(/Refused/);
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
    await expect(resolveAndValidate('rebind.example.com')).rejects.toThrow(/Refused/);
  });

  it('throws on mixed answers where any is blocked (multi-answer DNS)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.2.3.4', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expect(resolveAndValidate('mixed.example.com')).rejects.toThrow(/Refused/);
  });

  it('throws when DNS returns zero answers', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    await expect(resolveAndValidate('empty.example.com')).rejects.toThrow(/Refused/);
  });

  describe('bracketed IPv6 URL hostnames (URL.hostname returns [::1])', () => {
    it('throws on [::1] (loopback IPv6 in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [fd00::1] (ULA in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[fd00::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [fe80::1] (link-local in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[fe80::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [::] (unspecified in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[::]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('accepts a public IPv6 in bracketed URL form', async () => {
      const result = await resolveAndValidate('[2606:4700:4700::1111]');
      expect(result).toEqual(['2606:4700:4700::1111']);
      expect(mockedLookup).not.toHaveBeenCalled();
    });
  });
});

/**
 * Direct tests for the dispatcher's connect.lookup hook (AC1's socket-bound
 * validation). Service tests stub global fetch and never exercise this path,
 * so the rebinding-protection contract is verified here.
 */
describe('validatingLookup (socket-bound dispatcher hook)', () => {
  function callLookup(hostname: string): Promise<{ err: unknown; address: unknown; family: unknown }> {
    return new Promise((resolve) => {
      validatingLookup(hostname, {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
  }

  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('returns the first public address when DNS answers are all public', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
    const { err, address, family } = await callLookup('cdn.example.com');
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('rejects via callback when DNS returns a single private answer', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    const { err, address } = await callLookup('attacker.example.com');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Refused/);
    expect(address).toBe('');
  });

  it('rejects mixed-answer DNS at socket time (any private answer fails)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.2.3.4', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    const { err } = await callLookup('rebind.example.com');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Refused/);
  });

  it('rejects loopback IPv6 at socket time', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    const { err } = await callLookup('loopback.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects link-local IPv4 (AWS metadata) at socket time', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const { err } = await callLookup('rebind.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects metadata.google.internal hostname pre-check without doing DNS', async () => {
    const { err } = await callLookup('metadata.google.internal');
    expect(err).toBeInstanceOf(Error);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects bracketed IPv6 literal hostname (e.g. [::1]) at socket time', async () => {
    const { err } = await callLookup('[::1]');
    expect(err).toBeInstanceOf(Error);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('returns IP literal directly without DNS lookup when public', async () => {
    const { err, address } = await callLookup('8.8.8.8');
    expect(err).toBeNull();
    expect(address).toBe('8.8.8.8');
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects when DNS returns zero answers', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    const { err } = await callLookup('empty.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('propagates DNS errors via callback', async () => {
    const dnsErr = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    dnsErr.code = 'ENOTFOUND';
    mockedLookup.mockRejectedValueOnce(dnsErr);
    const { err } = await callLookup('missing.example.com');
    expect(err).toBe(dnsErr);
  });

  it('rejects on the second resolution when the same hostname rebinds to a blocked address', async () => {
    mockedLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

    const first = await callLookup('rebind.test');
    expect(first.err).toBeNull();
    expect(first.address).toBe('93.184.216.34');
    expect(first.family).toBe(4);

    const second = await callLookup('rebind.test');
    expect(second.err).toBeInstanceOf(Error);
    expect((second.err as Error).message).toMatch(/Refused.*resolves to blocked address 192\.168\.1\.1/);
    expect(second.address).toBe('');
    expect(second.family).toBe(0);

    expect(mockedLookup).toHaveBeenCalledTimes(2);
  });
});
