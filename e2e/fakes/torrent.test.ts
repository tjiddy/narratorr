import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTorrentBytes, computeInfoHash } from './torrent.js';

describe('buildTorrentBytes', () => {
  it('emits a bencoded outer dict wrapping an info dict', () => {
    const bytes = buildTorrentBytes({ fileName: 'foo.m4b', fileLength: 42 });
    const str = bytes.toString('binary');
    expect(str.startsWith('d4:info')).toBe(true);
    expect(str.endsWith('e')).toBe(true);
  });

  it('embeds the file length as a bencoded integer', () => {
    const bytes = buildTorrentBytes({ fileName: 'x', fileLength: 123456 });
    expect(bytes.toString('binary')).toContain('6:lengthi123456e');
  });

  it('embeds the file name with its byte length prefix', () => {
    const bytes = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 10 });
    expect(bytes.toString('binary')).toContain('4:name10:silent.m4b');
  });

  it('includes a 20-byte piece hash (placeholder)', () => {
    const bytes = buildTorrentBytes({ fileName: 'x', fileLength: 1 });
    const str = bytes.toString('binary');
    const idx = str.indexOf('6:pieces20:');
    expect(idx).toBeGreaterThan(-1);
    // 20 bytes after the prefix — all zeros in our placeholder
    const pieceStart = idx + '6:pieces20:'.length;
    for (let i = 0; i < 20; i++) {
      expect(bytes[pieceStart + i]).toBe(0);
    }
  });
});

describe('computeInfoHash', () => {
  it('returns the sha1 of the bencoded info dict', () => {
    const bytes = buildTorrentBytes({ fileName: 'foo', fileLength: 1 });

    // Outer wrapper is `d4:info<info_dict>e` — slice between the `4:info` marker
    // end (offset 7) and the final trailing `e` to recover the info dict bytes,
    // then hash them. Should match computeInfoHash exactly.
    const infoStart = bytes.indexOf(Buffer.from('4:info')) + '4:info'.length;
    const infoBytes = bytes.subarray(infoStart, bytes.length - 1);
    const expected = createHash('sha1').update(infoBytes).digest('hex');

    expect(computeInfoHash(bytes)).toBe(expected);
  });

  it('returns a 40-character lowercase hex string', () => {
    const bytes = buildTorrentBytes({ fileName: 'x', fileLength: 1 });
    const hash = computeInfoHash(bytes);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces stable hashes across identical inputs', () => {
    const a = buildTorrentBytes({ fileName: 'same', fileLength: 100 });
    const b = buildTorrentBytes({ fileName: 'same', fileLength: 100 });
    expect(computeInfoHash(a)).toBe(computeInfoHash(b));
  });

  it('produces different hashes for different file names', () => {
    const a = buildTorrentBytes({ fileName: 'alice', fileLength: 100 });
    const b = buildTorrentBytes({ fileName: 'bob', fileLength: 100 });
    expect(computeInfoHash(a)).not.toBe(computeInfoHash(b));
  });

  it('produces different hashes for different file lengths', () => {
    const a = buildTorrentBytes({ fileName: 'same', fileLength: 100 });
    const b = buildTorrentBytes({ fileName: 'same', fileLength: 200 });
    expect(computeInfoHash(a)).not.toBe(computeInfoHash(b));
  });

  it('returns null when the `4:info` marker is absent', () => {
    const junk = Buffer.from('not a torrent at all');
    expect(computeInfoHash(junk)).toBeNull();
  });

  it('returns null when info is not a bencoded dict (missing leading "d")', () => {
    const bad = Buffer.from('d4:infoi42ee');
    expect(computeInfoHash(bad)).toBeNull();
  });
});
