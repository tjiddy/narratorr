import { describe, it, expect } from 'vitest';
import {
  withBookAdmissionLock,
  hasPendingBookAdmission,
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
    expect(order).toEqual(['A:start']);

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

    await b;
    expect(order).toContain('B');
    releaseA();
    await a;
  });

  it('does not poison the next caller when a section throws', async () => {
    await expect(withBookAdmissionLock(9, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await withBookAdmissionLock(9, async () => 'ok');
    expect(ok).toBe('ok');
  });

  /**
   * #2369 F9. A follow-up acquisition completing is NOT evidence of eviction: a settled promise
   * left in the map still lets the next caller through, so the map grows one entry per book
   * forever and nothing fails. `hasPendingBookAdmission` observes the entry directly, the way
   * `hasPendingPathWrite` does for the path tier.
   */
  describe('key eviction', () => {
    it('holds the key while a section runs and drops it once the section resolves', async () => {
      let release!: () => void;
      const run = withBookAdmissionLock(31, async () => {
        await new Promise<void>((r) => { release = r; });
      });

      await Promise.resolve();
      expect(hasPendingBookAdmission(31)).toBe(true);

      release();
      await run;
      // Eviction is scheduled on the tail's continuation, so it lands a microtask later.
      await Promise.resolve();
      await Promise.resolve();
      expect(hasPendingBookAdmission(31)).toBe(false);
    });

    it('drops the key after a section REJECTS, not only after it resolves', async () => {
      await expect(withBookAdmissionLock(32, async () => { throw new Error('boom'); })).rejects.toThrow('boom');

      await Promise.resolve();
      await Promise.resolve();
      expect(hasPendingBookAdmission(32)).toBe(false);
    });

    it('keeps the key held while a successor is still queued behind the current holder', async () => {
      let releaseFirst!: () => void;
      const first = withBookAdmissionLock(33, async () => {
        await new Promise<void>((r) => { releaseFirst = r; });
      });
      const second = withBookAdmissionLock(33, async () => 'second');

      await Promise.resolve();
      expect(hasPendingBookAdmission(33)).toBe(true);

      releaseFirst();
      await first;
      // The first holder's eviction must not drop a key the successor still owns.
      expect(hasPendingBookAdmission(33)).toBe(true);

      await second;
      await Promise.resolve();
      await Promise.resolve();
      expect(hasPendingBookAdmission(33)).toBe(false);
    });

    it('reports no pending key for a book that was never acquired', () => {
      expect(hasPendingBookAdmission(34)).toBe(false);
    });
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
    expect(calls).toBe(1);

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
