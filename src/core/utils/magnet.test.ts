import { describe, it, expect } from 'vitest';
import { buildMagnetUri, parseInfoHash } from './magnet.js';

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

  it('includes all trackers', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const uri = buildMagnetUri(hash);

    expect(uri).toContain('tracker.opentrackr.org');
    expect(uri).toContain('open.stealth.si');
    expect(uri).toContain('tracker.torrent.eu.org');
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

    // base32 hashes are lowercased
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
