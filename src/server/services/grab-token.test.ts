import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeKey, _resetKey, getKey } from '../utils/secret-codec.js';
import { signReleaseId, verifyReleaseId } from './grab-token.js';
import { encodeReleaseId, type ReleaseTokenPayload } from '../../shared/schemas/v1/actions.js';
import { AuthService } from './auth.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';

const TEST_KEY = Buffer.alloc(32, 0x2b);

const PAYLOAD: ReleaseTokenPayload = {
  downloadUrl: 'http://indexer.example/torrent/1',
  title: 'The Way of Kings',
  protocol: 'torrent',
  guid: 'guid-1',
  infoHash: 'ABCDEF0123',
  indexerId: 3,
};

beforeEach(() => {
  _resetKey();
  initializeKey(TEST_KEY);
});

afterEach(() => {
  _resetKey();
});

describe('grab-token', () => {
  // 1. Round-trip stability
  it('round-trips: sign → verify returns the original payload', () => {
    const token = signReleaseId(PAYLOAD);
    expect(verifyReleaseId(token)).toEqual(PAYLOAD);
  });

  it('signing the same payload twice is byte-identical (idempotency/dedup invariant)', () => {
    expect(signReleaseId(PAYLOAD)).toBe(signReleaseId(PAYLOAD));
  });

  it('signed token carries the canonical body plus a signature segment', () => {
    const token = signReleaseId(PAYLOAD);
    const [body, sig] = token.split('.');
    expect(body).toBe(encodeReleaseId(PAYLOAD));
    expect(sig).toBeTruthy();
  });

  // 2. Tamper — body mutated, MAC stale
  it('rejects a token whose body was swapped for an attacker URL but kept the old signature', () => {
    const token = signReleaseId(PAYLOAD);
    const sig = token.split('.')[1]!;
    const forgedBody = encodeReleaseId({ ...PAYLOAD, downloadUrl: 'http://attacker/evil' });
    expect(verifyReleaseId(`${forgedBody}.${sig}`)).toBeNull();
  });

  // 3. Tamper — forged from scratch (the pre-fix unsigned forgery)
  it('rejects an unsigned body with no signature segment (the pre-fix forgery shape)', () => {
    const unsigned = encodeReleaseId({ downloadUrl: 'http://attacker/evil', title: 'T', protocol: 'torrent' });
    expect(verifyReleaseId(unsigned)).toBeNull();
  });

  // 4. Tamper — signature mutated
  it('rejects a token with a flipped character in the signature segment', () => {
    const token = signReleaseId(PAYLOAD);
    const [body, sig] = token.split('.') as [string, string];
    const last = sig.slice(-1);
    const tampered = `${body}.${sig.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(verifyReleaseId(tampered)).toBeNull();
  });

  // 5. Wrong-domain replay (SSE stream token <-> grab token are non-interchangeable)
  describe('domain separation from the SSE stream token', () => {
    const auth = new AuthService({} as Db, { debug: () => {} } as unknown as FastifyBaseLogger);
    const STREAM_SECRET = 'session-secret';

    it('a token signed with the stream-token label does not verify as a grab token', () => {
      const body = encodeReleaseId(PAYLOAD);
      const streamSig = createHmac('sha256', createHmac('sha256', getKey()).update('stream-token').digest())
        .update(body)
        .digest('base64url');
      expect(verifyReleaseId(`${body}.${streamSig}`)).toBeNull();
    });

    it('a real SSE stream token fails grab-token verification', () => {
      const streamToken = auth.mintStreamToken(STREAM_SECRET);
      expect(verifyReleaseId(streamToken)).toBeNull();
    });

    it('a grab token fails SSE stream-token verification (vice versa)', () => {
      const grabToken = signReleaseId(PAYLOAD);
      expect(auth.verifyStreamToken(grabToken, STREAM_SECRET)).toBeNull();
    });
  });

  // 6. Timing-safe / malformed shapes — each returns null, never throws
  it.each([
    ['empty string', ''],
    ['no separator', 'aGVsbG8'],
    ['extra separator segments', 'a.b.c'],
    ['empty body', '.sig'],
    ['empty signature', 'body.'],
    ['non-base64url body, valid-looking sig', '@@@not-base64url@@@.deadbeef'],
    ['valid base64url body that is not JSON', `${Buffer.from('not json', 'utf8').toString('base64url')}.deadbeef`],
  ])('returns null (never throws) for malformed token: %s', (_label, token) => {
    expect(verifyReleaseId(token)).toBeNull();
  });

  // 8. No client leak — the signing secret accessor must never be reachable from
  // the client bundle. Signing lives server-side; src/shared/ stays secret-free.
  describe('no client leak', () => {
    function tsFilesUnder(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...tsFilesUnder(full));
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    }

    it('no file under src/client imports the grab-token signer or the secret-codec key accessor', () => {
      const offenders = tsFilesUnder(join(process.cwd(), 'src', 'client')).filter((file) => {
        const src = readFileSync(file, 'utf8');
        return /from ['"][^'"]*grab-token/.test(src) || /from ['"][^'"]*secret-codec/.test(src);
      });
      expect(offenders).toEqual([]);
    });
  });
});
