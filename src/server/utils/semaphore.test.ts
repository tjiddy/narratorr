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

    first();
    await w1;
    r1();
    await w2;

    expect(order).toEqual([1, 2]);
  });

  it('setMax updates the capacity', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();

    sem.setMax(2);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it('tryAcquire returns null without blocking when no slots available', () => {
    const sem = new Semaphore(0);
    expect(sem.tryAcquire()).toBeNull();
  });

  it('release does not wake a waiter that would exceed a shrunk max', async () => {
    const sem = new Semaphore(2);
    const releaseA = await sem.acquire();
    const releaseB = await sem.acquire();

    let resolved = false;
    const waiting = sem.acquire().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    sem.setMax(1);

    // One release leaves active at the new max, so waking would exceed it.
    releaseA();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseB();
    await waiting;
    expect(resolved).toBe(true);
  });

  it('a token spent twice returns exactly ONE slot — the cap cannot inflate', () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();

    release!();
    release!();

    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it('a waiter woken by a spent token gets its OWN single-use token', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    const waiterToken = sem.acquire();
    first();
    const release = await waiterToken;

    release();
    release();
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });

  it("spending a stale token twice cannot free someone else's live slot", () => {
    const sem = new Semaphore(2);
    const releaseA = sem.tryAcquire()!;
    const releaseB = sem.tryAcquire()!;

    releaseA();
    releaseA();

    const releaseC = sem.tryAcquire();
    expect(releaseC).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();

    releaseB();
    releaseC!();
    expect(sem.tryAcquire()).not.toBeNull();
  });
});
