import { describe, it, expect } from 'vitest';
import { MAGNET_TRACKERS, buildMagnetUri, parseInfoHash } from './magnet.js';

describe('buildMagnetUri', () => {
  it('builds a valid magnet URI from info hash', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = buildMagnetUri(hash);

    expect(uri).toContain(`xt=urn%3Abtih%3A${hash}`);
    expect(uri).toMatch(/^magnet:\?/);
    expect(uri).toContain('tr=');
  });

  it('includes display name when provided', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = buildMagnetUri(hash, 'My Audiobook');

    expect(uri).toContain('dn=My+Audiobook');
  });

  it('omits display name when not provided', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = buildMagnetUri(hash);

    expect(uri).not.toContain('dn=');
  });

  it('appends exactly one tr param per tracker, in list order', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

    const params = new URL(buildMagnetUri(hash)).searchParams;

    expect(params.getAll('tr')).toEqual([...MAGNET_TRACKERS]);
  });
});

/**
 * #2420 — the list is refreshed by hand from ngosang/trackerslist, so what a test can hold it to is
 * structure and the two named removals, not liveness: reaching a tracker needs a network.
 */
describe('the tracker list', () => {
  it('carries neither of the entries #2420 retired', () => {
    const uri = buildMagnetUri('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');

    expect(uri).not.toContain('popcorn-tracker');
    expect(uri).not.toContain('dler.org');
    expect(MAGNET_TRACKERS.some((t) => t.includes('popcorn-tracker') || t.includes('dler.org'))).toBe(false);
  });

  it('keeps the six entries that were still healthy', () => {
    expect(MAGNET_TRACKERS).toEqual(expect.arrayContaining([
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://tracker.bittor.pw:1337/announce',
      'udp://exodus.desync.com:6969/announce',
      'udp://open.demonii.com:1337/announce',
    ]));
  });

  it('is non-empty and free of duplicates', () => {
    expect(MAGNET_TRACKERS.length).toBeGreaterThan(0);
    expect(new Set(MAGNET_TRACKERS).size).toBe(MAGNET_TRACKERS.length);
  });

  it.each([...MAGNET_TRACKERS])('parses %s as a udp/http/https announce URL with a host', (tracker) => {
    const parsed = new URL(tracker);

    expect(['udp:', 'http:', 'https:']).toContain(parsed.protocol);
    expect(parsed.hostname).not.toBe('');
    expect(parsed.pathname).toBe('/announce');
  });
});

describe('parseInfoHash', () => {
  it('extracts 40-char hex info hash from magnet URI', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = `magnet:?xt=urn:btih:${hash}&dn=test`;

    expect(parseInfoHash(uri)).toBe(hash);
  });

  it('extracts 32-char base32 info hash', () => {
    const hash = 'VLFHEXOM4XUKFWW55YHT3SBNT2XKSNIN';
    const uri = `magnet:?xt=urn:btih:${hash}&dn=test`;

    expect(parseInfoHash(uri)).toBe(hash.toLowerCase());
  });

  it('extracts info hash from URL-encoded magnet URI', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = `magnet:?xt=urn%3Abtih%3A${hash}&dn=test`;

    expect(parseInfoHash(uri)).toBe(hash);
  });

  it('round-trips through buildMagnetUri', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = buildMagnetUri(hash, 'Test Book');

    expect(parseInfoHash(uri)).toBe(hash);
  });

  // The refreshed tracker list widens the query string, so the round-trip is re-pinned for both
  // hash widths and for the optional display name in each direction.
  it.each([
    ['hex-40', 'AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D'],
    ['base32-32', 'VLFHEXOM4XUKFWW55YHT3SBNT2XKSNIN'],
  ])('round-trips a %s hash lowercased, named and unnamed', (_label, hash) => {
    expect(parseInfoHash(buildMagnetUri(hash, 'Test Book'))).toBe(hash.toLowerCase());
    expect(parseInfoHash(buildMagnetUri(hash))).toBe(hash.toLowerCase());
    expect(buildMagnetUri(hash, 'Test Book')).toContain('dn=Test+Book');
    expect(buildMagnetUri(hash)).not.toContain('dn=');
  });

  it('returns null for invalid magnet URI', () => {
    expect(parseInfoHash('not-a-magnet-uri')).toBeNull();
  });

  it('returns null for magnet URI with no info hash', () => {
    expect(parseInfoHash('magnet:?dn=test')).toBeNull();
  });

  it('lowercases the info hash', () => {
    const hash = 'AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D';
    const uri = `magnet:?xt=urn:btih:${hash}`;

    expect(parseInfoHash(uri)).toBe(hash.toLowerCase());
  });
});
