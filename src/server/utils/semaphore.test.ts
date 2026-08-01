import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it('spending the token frees a slot for tryAcquire', () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
    release!();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('acquire blocks when at capacity and resolves on release', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();

    let resolved = false;
    const waiting = sem.acquire().then(() => { resolved = true; });

    // Should not resolve yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    release();
    await waiting;
    expect(resolved).toBe(true);
  });

  it('FIFO order — first waiter gets slot first', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    const order: number[] = [];
    let r1!: () => void;
    const w1 = sem.acquire().then((r) => { r1 = r; order.push(1); });
    const w2 = sem.acquire().then(() => { order.push(2); });

    first(); // unblocks w1
    await w1;
    r1(); // unblocks w2
    await w2;

    expect(order).toEqual([1, 2]);
  });

  it('setMax updates the capacity', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();

    sem.setMax(2);
    // After setMax, one active slot, max is now 2 — should allow one more
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it('tryAcquire returns null without blocking when no slots available', () => {
    const sem = new Semaphore(0);
    expect(sem.tryAcquire()).toBeNull();
  });

  it('release does not wake a waiter that would exceed a shrunk max', async () => {
    const sem = new Semaphore(2);
    const releaseA = await sem.acquire(); // active 1
    const releaseB = await sem.acquire(); // active 2 (at max)

    let resolved = false;
    const waiting = sem.acquire().then(() => { resolved = true; }); // queued waiter
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Operator shrinks capacity below the active count.
    sem.setMax(1);

    // Releasing one slot leaves active (1) at the new max — the waiter must NOT wake,
    // otherwise active would climb back to 2 and exceed max.
    releaseA();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Dropping below max finally wakes the waiter.
    releaseB();
    await waiting;
    expect(resolved).toBe(true);
  });

  // ── #1984: the single-use token replaces per-caller double-release discipline ──

  it('a token spent twice returns exactly ONE slot — the cap cannot inflate', () => {
    // The defect this shape fixes: the old public release() decremented `active` with no
    // floor, so a double release drove it negative and permanently raised the process's
    // effective concurrency cap. With single-use tokens, N tokens can return at most N slots
    // no matter how many times each is called.
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();

    release!();
    release!(); // second spend must be a no-op, not a second decrement

    // If the double spend had gone through, active would be -1 and BOTH of these would
    // succeed. Exactly one may.
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it('a waiter woken by a spent token gets its OWN single-use token', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    const waiterToken = sem.acquire();
    first();
    const release = await waiterToken;

    // The waiter's token releases its slot once, and only once.
    release();
    release();
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it("spending a stale token twice cannot free someone else's live slot", () => {
    // The nastiest variant of the old bug: holder A double-releases and silently pays back
    // holder B's slot, so B's later release under-flows. Token identity makes each slot's
    // return attributable.
    const sem = new Semaphore(2);
    const releaseA = sem.tryAcquire()!;
    const releaseB = sem.tryAcquire()!;

    releaseA();
    releaseA(); // must NOT free B's slot

    // One slot free (A's), one still held (B's).
    const releaseC = sem.tryAcquire();
    expect(releaseC).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();

    releaseB();
    releaseC!();
    expect(sem.tryAcquire()).not.toBeNull();
  });
});
