import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { mintPreviewToken, verifyPreviewToken } from './preview-token.js';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

const TEST_KEY = Buffer.alloc(32, 0xab);

beforeEach(() => {
  _resetKey();
  initializeKey(TEST_KEY);
});

afterEach(() => {
  _resetKey();
  vi.useRealTimers();
});

describe('preview-token', () => {
  it('round-trips: mint → verify returns the original payload', () => {
    const token = mintPreviewToken('/library/book1/chapter.mp3', '/library/book1');
    const payload = verifyPreviewToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.purpose).toBe('audio-preview');
    expect(payload!.path).toBe('/library/book1/chapter.mp3');
    expect(payload!.scanRoot).toBe('/library/book1');
  });

  it('returns null for tampered signature (flipped byte)', () => {
    const token = mintPreviewToken('/p', '/r');
    const [body, sig] = token.split('.');
    // Flip the last char of the signature to a deterministically different one
    const last = sig!.slice(-1);
    const replacement = last === 'A' ? 'B' : 'A';
    const tampered = `${body}.${sig!.slice(0, -1)}${replacement}`;
    expect(verifyPreviewToken(tampered)).toBeNull();
  });

  it('returns null for tampered payload (re-encode body, original sig)', () => {
    const token = mintPreviewToken('/orig', '/root');
    const [, sig] = token.split('.');

    const evil = {
      purpose: 'audio-preview',
      path: '/etc/passwd',
      scanRoot: '/root',
      exp: Date.now() + 60_000,
    };
    const evilBody = Buffer.from(JSON.stringify(evil)).toString('base64url');
    const tampered = `${evilBody}.${sig}`;

    expect(verifyPreviewToken(tampered)).toBeNull();
  });

  it('returns null for malformed token (no dot)', () => {
    expect(verifyPreviewToken('abcdef')).toBeNull();
  });

  it('returns null for malformed token (too many dots)', () => {
    expect(verifyPreviewToken('a.b.c')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(verifyPreviewToken('')).toBeNull();
  });

  it('returns null for empty body segment', () => {
    expect(verifyPreviewToken('.somesig')).toBeNull();
  });

  it('returns null for empty sig segment', () => {
    expect(verifyPreviewToken('somebody.')).toBeNull();
  });

  it('returns null for expired token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = mintPreviewToken('/p', '/r');

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z')); // 1 hour later, well past 30-min TTL
    expect(verifyPreviewToken(token)).toBeNull();
  });

  it('returns null for wrong purpose', () => {
    // Manually craft a token with a wrong purpose value
    const payload = {
      purpose: 'something-else',
      path: '/p',
      scanRoot: '/r',
      exp: Date.now() + 60_000,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // Sign with the same derived key the mint function uses
    const signingKey = createHmac('sha256', TEST_KEY).update('audio-preview-token-v1').digest();
    const sig = createHmac('sha256', signingKey).update(body).digest('base64url');
    const token = `${body}.${sig}`;

    expect(verifyPreviewToken(token)).toBeNull();
  });

  it('handles different-length signature segments without throwing', () => {
    const token = mintPreviewToken('/p', '/r');
    const [body] = token.split('.');
    const tampered = `${body}.short`;
    expect(() => verifyPreviewToken(tampered)).not.toThrow();
    expect(verifyPreviewToken(tampered)).toBeNull();
  });

  it('returns null when JSON body is not parseable', () => {
    // Body that is valid base64url but garbage JSON
    const garbage = Buffer.from('not-json-at-all').toString('base64url');
    const signingKey = createHmac('sha256', TEST_KEY).update('audio-preview-token-v1').digest();
    const sig = createHmac('sha256', signingKey).update(garbage).digest('base64url');
    expect(verifyPreviewToken(`${garbage}.${sig}`)).toBeNull();
  });

  it('returns null when payload fails Zod validation (missing fields)', () => {
    const partial = { purpose: 'audio-preview' };
    const body = Buffer.from(JSON.stringify(partial)).toString('base64url');
    const signingKey = createHmac('sha256', TEST_KEY).update('audio-preview-token-v1').digest();
    const sig = createHmac('sha256', signingKey).update(body).digest('base64url');
    expect(verifyPreviewToken(`${body}.${sig}`)).toBeNull();
  });
});
