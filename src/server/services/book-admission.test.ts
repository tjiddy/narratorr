import { describe, it, expect } from 'vitest';
import {
  withBookAdmissionLock,
  singleFlightReplace,
  hasInFlightReplace,
  canonicalReleaseIdentity,
} from './book-admission.js';

describe('canonicalReleaseIdentity (#1857)', () => {
  it('prefers guid (scoped to indexerId) over infoHash and url', () => {
    expect(canonicalReleaseIdentity({ guid: 'g', indexerId: 3, infoHash: 'H', downloadUrl: 'u' })).toBe('guid:3:g');
    expect(canonicalReleaseIdentity({ guid: 'g', downloadUrl: 'u' })).toBe('guid::g');
  });
  it('falls back to normalized infoHash, then downloadUrl', () => {
    expect(canonicalReleaseIdentity({ infoHash: 'ABCdef', downloadUrl: 'u' })).toBe('hash:abcdef');
    expect(canonicalReleaseIdentity({ downloadUrl: 'magnet:?x' })).toBe('url:magnet:?x');
  });
});

describe('withBookAdmissionLock (#1857 AC5/AC17)', () => {
  it('serializes sections for the same bookId (no overlap)', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const a = withBookAdmissionLock(1, async () => {
      order.push('A:start');
      await new Promise<void>((r) => { releaseA = r; });
      order.push('A:end');
    });
    const b = withBookAdmissionLock(1, async () => {
      order.push('B:start');
      order.push('B:end');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['A:start']); // B queued behind A, not started

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different books concurrently', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const a = withBookAdmissionLock(1, async () => {
      order.push('A:start');
      await new Promise<void>((r) => { releaseA = r; });
    });
    const b = withBookAdmissionLock(2, async () => { order.push('B'); });

    await b; // B completes without waiting on A's still-open section
    expect(order).toContain('B');
    releaseA();
    await a;
  });

  it('does not poison the next caller when a section throws', async () => {
    await expect(withBookAdmissionLock(9, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await withBookAdmissionLock(9, async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('singleFlightReplace (#1857 AC5)', () => {
  it('coalesces concurrent identical operations to a single run', async () => {
    let calls = 0;
    let release!: (v: number) => void;
    const op = () => { calls++; return new Promise<number>((r) => { release = r; }); };

    const p1 = singleFlightReplace('k', op);
    const p2 = singleFlightReplace('k', op);
    await Promise.resolve();
    expect(calls).toBe(1); // p2 joined p1's in-flight promise

    release(99);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.downloadId).toBe(99);
    expect(r2.downloadId).toBe(99);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);
  });

  it('evicts on resolve — a post-settlement call runs a FRESH op (no post-settlement dedup, F36)', async () => {
    let calls = 0;
    const op = () => { calls++; return Promise.resolve(calls); };

    const r1 = await singleFlightReplace('k2', op);
    expect(hasInFlightReplace('k2')).toBe(false);
    const r2 = await singleFlightReplace('k2', op);

    expect(calls).toBe(2);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
  });

  it('evicts on reject and propagates the rejection to every joined waiter', async () => {
    let release!: (e: Error) => void;
    const op = () => new Promise<number>((_res, rej) => { release = rej; });

    const p1 = singleFlightReplace('k3', op);
    const p2 = singleFlightReplace('k3', op);
    await Promise.resolve();

    release(new Error('fail'));
    await expect(p1).rejects.toThrow('fail');
    await expect(p2).rejects.toThrow('fail');
    expect(hasInFlightReplace('k3')).toBe(false);
  });
});
