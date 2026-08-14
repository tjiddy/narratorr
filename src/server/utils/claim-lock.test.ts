import { describe, it, expect, vi } from 'vitest';
import { canonicalPath } from './path-identity.js';
import { hasPendingPathWrite, withPathWriteLock, withPathWriteLocks } from './path-write-lock.js';
import { ClaimKeyChurnError, MAX_CLAIM_KEY_REACQUIRES, claimLockKey, withFreshClaimLock } from './claim-lock.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('claimLockKey', () => {
  it('is exactly canonicalPath, so ownership identity and lock identity cannot drift', () => {
    for (const spelling of ['/library/Y', '/library/Y/', '/library/A/../Y', '/library\\A\\..\\Y', '/x/a.m4b']) {
      expect(claimLockKey(spelling)).toBe(canonicalPath(spelling));
    }
  });

  it('collapses aliased spellings of one folder onto one key', () => {
    expect(claimLockKey('/library\\A\\..\\Y')).toBe(claimLockKey('/library/Y'));
  });
});

describe('withPathWriteLocks', () => {
  it('serializes two callers whose key sets are mirrored, without deadlocking', async () => {
    const gate = deferred();
    const order: string[] = [];

    const first = withPathWriteLocks([canonicalPath('/lib/A'), canonicalPath('/lib/B')], async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    await tick();
    // Mirrored order: a naive per-caller acquisition order would deadlock here.
    const second = withPathWriteLocks([canonicalPath('/lib/B'), canonicalPath('/lib/A')], async () => {
      order.push('second:start');
    });

    await tick();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('collapses a duplicated key rather than self-deadlocking on the non-reentrant lock', async () => {
    const key = canonicalPath('/lib/A');
    await expect(withPathWriteLocks([key, key, canonicalPath('/lib/A/')], async () => 'done')).resolves.toBe('done');
  });

  it('releases every key after a success and after a failure', async () => {
    const a = canonicalPath('/lib/A');
    const b = canonicalPath('/lib/B');

    await withPathWriteLocks([a, b], async () => undefined);
    await tick();
    expect(hasPendingPathWrite(a)).toBe(false);
    expect(hasPendingPathWrite(b)).toBe(false);

    await expect(withPathWriteLocks([a, b], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await tick();
    expect(hasPendingPathWrite(a)).toBe(false);
    expect(hasPendingPathWrite(b)).toBe(false);
  });

  it('blocks a single-key caller that overlaps one of the held keys', async () => {
    const gate = deferred();
    const order: string[] = [];

    const holder = withPathWriteLocks([canonicalPath('/lib/C'), canonicalPath('/lib/D')], async () => {
      order.push('holder');
      await gate.promise;
    });
    await tick();
    const overlapping = withPathWriteLock(canonicalPath('/lib/D'), async () => { order.push('overlapping'); });

    await tick();
    expect(order).toEqual(['holder']);
    gate.resolve();
    await Promise.all([holder, overlapping]);
    expect(order).toEqual(['holder', 'overlapping']);
  });
});

describe('withFreshClaimLock', () => {
  it('runs the operation on the path the row names under the lock', async () => {
    const op = vi.fn().mockResolvedValue('swept');
    await expect(withFreshClaimLock(async () => '/library/Y', op)).resolves.toBe('swept');
    expect(op).toHaveBeenCalledWith(canonicalPath('/library/Y'));
  });

  it('runs the operation with null — and takes no lock — when the row has no path', async () => {
    const op = vi.fn().mockResolvedValue('committed');
    await expect(withFreshClaimLock(async () => null, op)).resolves.toBe('committed');
    expect(op).toHaveBeenCalledWith(null);
    expect(hasPendingPathWrite(canonicalPath('/library/Y'))).toBe(false);
  });

  it('releases and re-acquires on the fresh path when the row moved under the lock', async () => {
    const paths = ['/library/Y', '/library/Z', '/library/Z', '/library/Z'];
    let call = 0;
    const seen: Array<string | null> = [];

    const result = await withFreshClaimLock(
      async () => paths[call++] ?? null,
      async (locked) => { seen.push(locked); return locked; },
    );

    expect(seen).toEqual([canonicalPath('/library/Z')]);
    expect(result).toBe(canonicalPath('/library/Z'));
    await tick();
    expect(hasPendingPathWrite(canonicalPath('/library/Y'))).toBe(false);
    expect(hasPendingPathWrite(canonicalPath('/library/Z'))).toBe(false);
  });

  it('treats aliased spellings as the same claim and does not re-acquire', async () => {
    const spellings = ['/library/Y', '/library\\A\\..\\Y'];
    let call = 0;
    const op = vi.fn().mockResolvedValue(undefined);

    await withFreshClaimLock(async () => spellings[call++] ?? '/library/Y', op);

    expect(op).toHaveBeenCalledTimes(1);
    expect(call).toBe(2);
  });

  it('throws ClaimKeyChurnError — bounded, not looping — when the path changes on every attempt', async () => {
    let call = 0;
    const op = vi.fn();

    await expect(withFreshClaimLock(async () => `/library/${call++}`, op)).rejects.toBeInstanceOf(ClaimKeyChurnError);

    expect(op).not.toHaveBeenCalled();
    // One pre-lock read plus one in-lock read per attempt; the initial acquisition plus the bound.
    expect(call).toBe(2 * (MAX_CLAIM_KEY_REACQUIRES + 1));
  }, 5000);

  it('releases the key when the operation throws', async () => {
    await expect(
      withFreshClaimLock(async () => '/library/Y', async () => { throw new Error('sweep failed'); }),
    ).rejects.toThrow('sweep failed');
    await tick();
    expect(hasPendingPathWrite(canonicalPath('/library/Y'))).toBe(false);
  });

  it('waits behind a concurrent holder of the same claim key', async () => {
    const key = claimLockKey('/library/Y');
    const gate = deferred();
    const order: string[] = [];

    const holder = withPathWriteLock(key, async () => { order.push('holder'); await gate.promise; });
    await tick();
    // Aliased spelling on the queued side: it must still contend on the canonical key.
    const queued = withFreshClaimLock(async () => '/library\\A\\..\\Y', async () => { order.push('queued'); });

    await tick();
    expect(order).toEqual(['holder']);
    gate.resolve();
    await Promise.all([holder, queued]);
    expect(order).toEqual(['holder', 'queued']);
  });
});
