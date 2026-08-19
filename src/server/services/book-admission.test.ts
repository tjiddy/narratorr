import { describe, it, expect, vi } from 'vitest';
import {
  withBookAdmissionLock,
  withBookAdmissionLocks,
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

describe('withBookAdmissionLocks (#2447 AC1/AC1a)', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

  it('serializes mirrored sets instead of deadlocking', async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withBookAdmissionLocks([3, 7], async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = withBookAdmissionLocks([7, 3], async () => { order.push('second'); });

    await settle();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  /**
   * The observable difference between numeric and lexicographic order, not a hang: `[2, 10].sort()`
   * and `[10, 2].sort()` both yield `[10, 2]`, so a bare sort is deterministic and therefore still
   * deadlock-free — just not id order. Under it the batch would already hold 10 while blocked on 2.
   */
  it('acquires in numeric ascending order, so a batch blocked on its low key never touched its high one', async () => {
    const holder = deferred();
    const held = withBookAdmissionLock(2, () => holder.promise);
    const batch = withBookAdmissionLocks([2, 10], async () => 'done');

    await settle();
    expect(hasPendingBookAdmission(2)).toBe(true);
    expect(hasPendingBookAdmission(10)).toBe(false);

    holder.resolve();
    expect(await batch).toBe('done');
    await held;
  });

  it('holds its acquired prefix while blocked: a disjoint batch proceeds, an overlapping one waits', async () => {
    const holder = deferred();
    const held = withBookAdmissionLock(5, () => holder.promise);
    const order: string[] = [];
    const blocked = withBookAdmissionLocks([1, 5, 9], async () => { order.push('blocked'); });
    await settle();

    const disjoint = withBookAdmissionLocks([2, 8], async () => { order.push('disjoint'); });
    // Shares key 1, which the blocked batch already holds — head-of-line blocking (AC1a).
    const overlapping = withBookAdmissionLocks([1, 9], async () => { order.push('overlapping'); });

    await disjoint;
    expect(order).toEqual(['disjoint']);

    holder.resolve();
    await Promise.all([held, blocked, overlapping]);
    expect(order).toEqual(['disjoint', 'blocked', 'overlapping']);
  });

  it('collapses duplicate ids rather than self-deadlocking on the non-reentrant lock', async () => {
    await expect(withBookAdmissionLocks([4, 4, 4], async () => 'ok')).resolves.toBe('ok');
  });

  it('runs fn exactly once and acquires nothing for an empty set', async () => {
    const fn = vi.fn().mockResolvedValue('empty');
    expect(await withBookAdmissionLocks([], fn)).toBe('empty');
    expect(fn).toHaveBeenCalledTimes(1);
    for (const id of [0, 1, 2]) expect(hasPendingBookAdmission(id)).toBe(false);
  });

  it('releases every level when the body throws, and poisons no key', async () => {
    await expect(withBookAdmissionLocks([11, 12, 13], async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    await settle();
    for (const id of [11, 12, 13]) expect(hasPendingBookAdmission(id)).toBe(false);
    await expect(withBookAdmissionLocks([11, 12, 13], async () => 'ok')).resolves.toBe('ok');
  });

  it('evicts every key after a successful multi-acquisition', async () => {
    await withBookAdmissionLocks([21, 22], async () => 'ok');

    await settle();
    expect([21, 22].map((id) => hasPendingBookAdmission(id))).toEqual([false, false]);
  });

  it('composes with a single acquisition: the batch waits for the single holder', async () => {
    const gate = deferred();
    const order: string[] = [];
    const single = withBookAdmissionLock(5, async () => { await gate.promise; order.push('single'); });
    const batch = withBookAdmissionLocks([1, 5, 9], async () => { order.push('batch'); });

    await settle();
    expect(order).toEqual([]);

    gate.resolve();
    await Promise.all([single, batch]);
    expect(order).toEqual(['single', 'batch']);
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
