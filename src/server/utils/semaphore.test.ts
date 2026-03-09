import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
  });

  it('release frees a slot for tryAcquire', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });

  it('acquire blocks when at capacity and resolves on release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const waiting = sem.acquire().then(() => { resolved = true; });

    // Should not resolve yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    sem.release();
    await waiting;
    expect(resolved).toBe(true);
  });

  it('FIFO order — first waiter gets slot first', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const w1 = sem.acquire().then(() => { order.push(1); });
    const w2 = sem.acquire().then(() => { order.push(2); });

    sem.release(); // unblocks w1
    await w1;
    sem.release(); // unblocks w2
    await w2;

    expect(order).toEqual([1, 2]);
  });

  it('setMax updates the capacity', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);

    sem.setMax(2);
    // After setMax, one active slot, max is now 2 — should allow one more
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
  });

  it('tryAcquire returns false without blocking when no slots available', () => {
    const sem = new Semaphore(0);
    expect(sem.tryAcquire()).toBe(false);
  });
});
