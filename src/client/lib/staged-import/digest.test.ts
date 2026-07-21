import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { serializeSubmissionForDigest, type StagedImportItem, type SubmissionDigestInput } from '../../../core/import-staging/schemas.js';
import { sha256Hex } from './sha256.js';
import { computeSubmissionDigest } from './digest.js';

/** The server oracle: node:crypto SHA-256 hex over the same canonical string. */
function serverDigest(input: SubmissionDigestInput): string {
  return createHash('sha256').update(serializeSubmissionForDigest(input)).digest('hex');
}

const enc = new TextEncoder();

const item = (path: string, title: string): StagedImportItem => ({ path, title, metadata: { title, authors: [{ name: 'A' }] } });

describe('sha256Hex — known vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex(enc.encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('hashes "abc"', () => {
    expect(sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('hashes a multi-block message (> 64 bytes)', () => {
    const msg = 'a'.repeat(1000);
    expect(sha256Hex(enc.encode(msg))).toBe(createHash('sha256').update(msg).digest('hex'));
  });
  it('hashes multibyte UTF-8 identically to node', () => {
    const msg = 'café — 日本語 — 📚';
    expect(sha256Hex(enc.encode(msg))).toBe(createHash('sha256').update(msg).digest('hex'));
  });
});

describe('computeSubmissionDigest — agreement with the server oracle', () => {
  const library: SubmissionDigestInput = { source: 'library', items: [item('/a', 'A'), item('/b', 'B')] };
  const manualCopy: SubmissionDigestInput = { source: 'manual', mode: 'copy', items: [item('/a', 'A')] };
  const manualMove: SubmissionDigestInput = { source: 'manual', mode: 'move', items: [item('/a', 'A')] };
  const multibyte: SubmissionDigestInput = { source: 'library', items: [item('/本', '日本語 📚')] };

  it.each([
    ['library (mode absent)', library],
    ['manual copy', manualCopy],
    ['manual move', manualMove],
    ['multibyte data', multibyte],
  ])('secure path agrees with the server vector — %s', async (_label, input) => {
    const digest = await computeSubmissionDigest(input);
    expect(digest).toBe(serverDigest(input));
    expect(digest).toMatch(/^[0-9a-f]{64}$/); // lowercase hex
  });

  it('is independent of key insertion order (same digest)', async () => {
    const a: StagedImportItem = { path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } };
    const b: StagedImportItem = { title: 'A', path: '/a', metadata: { authors: [{ name: 'X' }], title: 'A' } };
    expect(await computeSubmissionDigest({ source: 'library', items: [a] }))
      .toBe(await computeSubmissionDigest({ source: 'library', items: [b] }));
  });

  it('is sensitive to item order (different digest)', async () => {
    const forward: SubmissionDigestInput = { source: 'library', items: [item('/a', 'A'), item('/b', 'B')] };
    const reversed: SubmissionDigestInput = { source: 'library', items: [item('/b', 'B'), item('/a', 'A')] };
    expect(await computeSubmissionDigest(forward)).not.toBe(await computeSubmissionDigest(reversed));
  });

  it('falls back to the pure-JS path when crypto.subtle is absent — identical digest', async () => {
    const digest = await computeSubmissionDigest(library, undefined);
    expect(digest).toBe(serverDigest(library));
  });

  it('falls back when crypto.subtle.digest rejects — identical digest', async () => {
    const subtle = { digest: vi.fn(() => Promise.reject(new Error('insecure context'))) } as unknown as SubtleCrypto;
    const digest = await computeSubmissionDigest(library, subtle);
    expect(subtle.digest).toHaveBeenCalledOnce();
    expect(digest).toBe(serverDigest(library));
  });

  it('secure and fallback paths yield byte-for-byte equal digests', async () => {
    const secure = await computeSubmissionDigest(manualCopy);
    const fallback = await computeSubmissionDigest(manualCopy, undefined);
    expect(secure).toBe(fallback);
  });
});
